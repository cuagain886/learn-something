package dev.deepjava.agent;

public final class AgentApplication {
    private AgentApplication() { }

    public static void main(String[] args) {
        DemoService service = new DemoService();
        assert service.work("tool").equals("TOOL");
        try {
            service.work(" ");
            throw new AssertionError("failure path expected");
        } catch (IllegalArgumentException expected) {
            // Advice must still record the exceptional exit.
        }
        System.out.println("agent application verified");
    }
}
