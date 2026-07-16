# syntax=docker/dockerfile:1

FROM golang:1.26.4-alpine AS test
WORKDIR /src
COPY go.mod ./
COPY . .
RUN --mount=type=cache,target=/root/.cache/go-build go test ./...

FROM test AS build
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w -X main.version=$VERSION" -o /out/server ./cmd/server

FROM scratch
COPY --from=build --chown=65532:65532 /out/server /server
USER 65532:65532
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=5 \
  CMD ["/server", "healthcheck"]
ENTRYPOINT ["/server"]
