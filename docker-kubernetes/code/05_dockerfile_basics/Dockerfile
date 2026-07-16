# syntax=docker/dockerfile:1

# 这是教学用基线：构建和运行都使用 Go 工具链镜像。
# 第 06 课会用多阶段构建移除最终镜像中的源码和编译器。
FROM golang:1.26.4-alpine

WORKDIR /src

# COPY 的源路径相对于 build context，而不是 Dockerfile 所在位置。
COPY go.mod ./
COPY main.go main_test.go ./

# RUN 在构建期执行；测试失败会阻止镜像产生。
RUN go test ./... && \
    CGO_ENABLED=0 go build -trimpath -o /usr/local/bin/course-server .

# ENV 是运行默认值，docker run -e 可以覆盖。
ENV PORT=8080 \
    MESSAGE="hello from the lesson-05 image"

# EXPOSE 只声明容器端口，不会自动发布宿主端口。
EXPOSE 8080

STOPSIGNAL SIGTERM

# exec form 让 Go 程序直接成为容器 PID 1，正确接收停止信号。
CMD ["/usr/local/bin/course-server"]
