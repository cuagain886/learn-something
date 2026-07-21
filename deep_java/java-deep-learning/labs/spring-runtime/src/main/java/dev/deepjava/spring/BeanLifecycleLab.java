package dev.deepjava.spring;

import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.util.ArrayList;
import java.util.List;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.BeanNameAware;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

public final class BeanLifecycleLab {
    private static final List<String> EVENTS = new ArrayList<>();

    @Configuration(proxyBeanMethods = false)
    static class Config {
        @Bean static org.springframework.beans.factory.config.BeanFactoryPostProcessor definitionsReady() {
            return beanFactory -> EVENTS.add("factory-post");
        }

        @Bean static BeanPostProcessor probePostProcessor() {
            return new BeanPostProcessor() {
                @Override public Object postProcessBeforeInitialization(Object bean, String name) throws BeansException {
                    if (name.equals("probe")) EVENTS.add("before-init");
                    return bean;
                }
                @Override public Object postProcessAfterInitialization(Object bean, String name) throws BeansException {
                    if (name.equals("probe")) EVENTS.add("after-init");
                    return bean;
                }
            };
        }

        @Bean(destroyMethod = "customDestroy") LifecycleProbe probe() { return new LifecycleProbe(); }
    }

    static final class LifecycleProbe implements BeanNameAware, InitializingBean, DisposableBean {
        LifecycleProbe() { EVENTS.add("constructor"); }
        @Override public void setBeanName(String name) { EVENTS.add("aware:" + name); }
        @PostConstruct void postConstruct() { EVENTS.add("post-construct"); }
        @Override public void afterPropertiesSet() { EVENTS.add("after-properties"); }
        @PreDestroy void preDestroy() { EVENTS.add("pre-destroy"); }
        @Override public void destroy() { EVENTS.add("disposable-destroy"); }
        void customDestroy() { EVENTS.add("custom-destroy"); }
    }

    private BeanLifecycleLab() { }

    public static void main(String[] args) {
        EVENTS.clear();
        try (AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext(Config.class)) {
            context.getBean(LifecycleProbe.class);
            assert EVENTS.equals(List.of("factory-post", "constructor", "aware:probe", "before-init",
                    "post-construct", "after-properties", "after-init")) : EVENTS;
        }
        assert EVENTS.subList(EVENTS.size() - 3, EVENTS.size()).equals(
                List.of("pre-destroy", "disposable-destroy", "custom-destroy")) : EVENTS;
        System.out.println("Spring bean lifecycle verified: " + EVENTS);
    }
}
