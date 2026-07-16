# syntax=docker/dockerfile:1

FROM golang:1.26.4-alpine AS test
WORKDIR /src
COPY go.mod ./
COPY main.go main_test.go ./
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
      -o /out/server .

# scratch 没有 shell、包管理器和 CA bundle；本服务不访问外部 TLS，因此只需静态二进制。
FROM scratch AS runtime
COPY --from=build --chown=65532:65532 /out/server /server

# 数字 UID/GID 不依赖 /etc/passwd；端口 8080 不需要绑定低端口能力。
USER 65532:65532
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
  CMD ["/server", "healthcheck"]
ENTRYPOINT ["/server"]
