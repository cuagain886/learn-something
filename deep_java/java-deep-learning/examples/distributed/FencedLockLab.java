package dev.deepjava.distributed;

import java.util.concurrent.atomic.AtomicLong;

/** Lease expiry alone cannot stop a paused old owner; a resource-side fencing token can. */
public final class FencedLockLab {
    record Lease(String owner, long token, long expiresAt) { }

    static final class LockService {
        private final AtomicLong sequence = new AtomicLong();
        private Lease current;
        synchronized Lease acquire(String owner, long now, long ttl) {
            if (current != null && current.expiresAt() > now) throw new IllegalStateException("busy");
            current = new Lease(owner, sequence.incrementAndGet(), Math.addExact(now, ttl));
            return current;
        }
        synchronized boolean release(Lease lease) {
            if (current != null && current.owner().equals(lease.owner()) && current.token() == lease.token()) {
                current = null;
                return true;
            }
            return false;
        }
    }

    static final class FencedResource {
        private long highestToken;
        private String value;
        synchronized boolean write(long token, String next) {
            if (token < highestToken) return false;
            highestToken = token;
            value = next;
            return true;
        }
    }

    private FencedLockLab() { }

    public static void main(String[] args) {
        LockService locks = new LockService();
        FencedResource resource = new FencedResource();
        Lease slow = locks.acquire("slow", 0, 10);
        Lease current = locks.acquire("current", 11, 10); // slow owner was paused beyond its lease
        assert resource.write(current.token(), "new-owner");
        assert !resource.write(slow.token(), "stale-owner");
        assert resource.value.equals("new-owner");
        assert !locks.release(slow); // compare owner + token prevents deleting the new lease
        assert locks.release(current);
        System.out.println("lease ownership and fencing-token stale writer rejection verified");
    }
}
