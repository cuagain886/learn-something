package dev.deepjava.distributed;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Unknown response + retry, transactional outbox relay and consumer inbox deduplication. */
public final class IdempotencyOutboxLab {
    record Operation(String requestHash, String result) { }
    record Event(String id, String payload) { }

    static final class ServiceStore {
        private final Map<String, Operation> operations = new HashMap<>();
        private final List<Event> outbox = new ArrayList<>();
        private int businessEffects;

        synchronized String handle(String idempotencyKey, String payload) {
            String requestHash = Integer.toHexString(payload.hashCode());
            Operation existing = operations.get(idempotencyKey);
            if (existing != null) {
                if (!existing.requestHash().equals(requestHash)) throw new IllegalArgumentException("key reused with different payload");
                return existing.result();
            }
            businessEffects++;
            String result = "result-" + businessEffects;
            operations.put(idempotencyKey, new Operation(requestHash, result));
            outbox.add(new Event("event:" + idempotencyKey, result));
            return result;
        }
    }

    static final class Consumer {
        private final Set<String> inbox = new HashSet<>();
        private int applied;
        synchronized void accept(Event event) {
            if (inbox.add(event.id())) applied++;
        }
    }

    private IdempotencyOutboxLab() { }

    public static void main(String[] args) {
        ServiceStore service = new ServiceStore();
        Consumer consumer = new Consumer();
        String first = service.handle("run-42:tool-3", "charge=10");
        // Response is now lost: the durable operation and outbox event exist, caller sees a timeout.
        String retried = service.handle("run-42:tool-3", "charge=10");
        assert retried.equals(first);
        assert service.businessEffects == 1;
        try {
            service.handle("run-42:tool-3", "charge=99");
            throw new AssertionError("same key with changed request must conflict");
        } catch (IllegalArgumentException expected) { }

        Event pending = service.outbox.getFirst();
        consumer.accept(pending); // relay delivery
        consumer.accept(pending); // crash before ack causes redelivery
        assert consumer.applied == 1;
        System.out.println("idempotent retry, outbox recovery and inbox deduplication verified");
    }
}
