# syntax=docker/dockerfile:1

FROM golang:1.26.4-alpine AS dependencies
WORKDIR /src

# 低频变化的依赖描述先复制，使业务源码变化不会使依赖步骤失效。
COPY go.mod ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

FROM dependencies AS test
COPY . .
RUN --mount=type=cache,target=/root/.cache/go-build \
    go test ./...

FROM test AS build
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
ARG COMMIT=unknown
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath \
      -ldflags="-s -w -X main.version=$VERSION -X main.commit=$COMMIT" \
      -o /out/server ./cmd/server

# 最终镜像只保留运行时和编译产物，不带 Go 工具链、源码与构建缓存。
FROM alpine:3.22 AS runtime
RUN addgroup -S app && adduser -S -D -H -u 10001 -G app app
COPY --from=build --chown=10001:10001 /out/server /usr/local/bin/server

USER 10001:10001
ENV MESSAGE="hello from the lesson-06 runtime image"
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/server"]
