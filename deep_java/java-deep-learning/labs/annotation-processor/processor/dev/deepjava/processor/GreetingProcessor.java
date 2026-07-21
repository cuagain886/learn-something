package dev.deepjava.processor;

import java.io.IOException;
import java.io.Writer;
import java.util.Set;
import javax.annotation.processing.AbstractProcessor;
import javax.annotation.processing.Filer;
import javax.annotation.processing.RoundEnvironment;
import javax.annotation.processing.SupportedAnnotationTypes;
import javax.annotation.processing.SupportedSourceVersion;
import javax.lang.model.SourceVersion;
import javax.lang.model.element.Element;
import javax.lang.model.element.TypeElement;
import javax.tools.Diagnostic;
import javax.tools.JavaFileObject;

@SupportedAnnotationTypes("dev.deepjava.processor.GenerateGreeting")
@SupportedSourceVersion(SourceVersion.RELEASE_21)
public final class GreetingProcessor extends AbstractProcessor {
    @Override
    public boolean process(Set<? extends TypeElement> annotations, RoundEnvironment roundEnvironment) {
        Filer filer = processingEnv.getFiler();
        for (Element element : roundEnvironment.getElementsAnnotatedWith(GenerateGreeting.class)) {
            TypeElement type = (TypeElement) element;
            GenerateGreeting annotation = type.getAnnotation(GenerateGreeting.class);
            String packageName = processingEnv.getElementUtils().getPackageOf(type).getQualifiedName().toString();
            String generatedName = type.getSimpleName() + "Greeting";
            try {
                JavaFileObject source = filer.createSourceFile(packageName + "." + generatedName, type);
                try (Writer writer = source.openWriter()) {
                    writer.write("package " + packageName + ";\n\n");
                    writer.write("public final class " + generatedName + " {\n");
                    writer.write("    public static String message() { return \"");
                    writer.write(escape(annotation.value()));
                    writer.write("\"; }\n");
                    writer.write("}\n");
                }
            } catch (IOException failure) {
                processingEnv.getMessager().printMessage(
                        Diagnostic.Kind.ERROR, "cannot generate greeting: " + failure.getMessage(), type);
            }
        }
        return true;
    }

    private static String escape(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r");
    }
}
