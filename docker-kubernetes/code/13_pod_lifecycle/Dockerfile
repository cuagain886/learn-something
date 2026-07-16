# syntax=docker/dockerfile:1
FROM golang:1.26.4-alpine AS build
WORKDIR /src
COPY go.mod main.go main_test.go ./
RUN --mount=type=cache,target=/root/.cache/go-build \
    go test ./... && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/server .

FROM scratch
COPY --from=build --chown=65532:65532 /out/server /server
USER 65532:65532
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/server"]
