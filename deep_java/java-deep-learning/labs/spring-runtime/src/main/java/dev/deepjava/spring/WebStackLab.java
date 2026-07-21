package dev.deepjava.spring;

import java.util.List;
import org.springframework.http.MediaType;
import org.springframework.test.web.reactive.server.WebTestClient;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Flux;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

public final class WebStackLab {
    @RestController
    static class MvcController {
        @GetMapping(value = "/mvc/{id}", produces = MediaType.TEXT_PLAIN_VALUE)
        String get(@PathVariable String id) { return "mvc:" + id; }
    }

    private WebStackLab() { }

    public static void main(String[] args) throws Exception {
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new MvcController()).build();
        var mvcResponse = mvc.perform(get("/mvc/{id}", "42"))
                .andReturn().getResponse();
        assert mvcResponse.getStatus() == 200;
        assert mvcResponse.getContentAsString().equals("mvc:42");

        RouterFunction<ServerResponse> route = RouterFunctions.route()
                .GET("/flux", request -> ServerResponse.ok()
                        .contentType(MediaType.APPLICATION_JSON)
                        .body(Flux.just("one", "two"), String.class))
                .build();
        WebTestClient client = WebTestClient.bindToRouterFunction(route).build();
        List<String> body = client.get().uri("/flux").exchange()
                .expectStatus().isOk()
                .returnResult(String.class).getResponseBody().collectList().block();
        assert body != null && body.equals(List.of("one", "two")) : body;
        System.out.println("MVC mapping and WebFlux publisher verified");
    }
}
