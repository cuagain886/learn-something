package main

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
)

var ErrInvalidChildSpec = errors.New("invalid child process specification")

type ChildSpec struct {
	Executable string
	Args, Env  []string
}
type ChildResult struct {
	ExitCode int
	Output   string
	TimedOut bool
}

func RunChild(ctx context.Context, spec ChildSpec) (ChildResult, error) {
	if spec.Executable == "" {
		return ChildResult{}, ErrInvalidChildSpec
	}
	command := exec.CommandContext(ctx, spec.Executable, spec.Args...)
	if spec.Env != nil {
		command.Env = spec.Env
	}
	output, err := command.CombinedOutput()
	result := ChildResult{Output: string(output)}
	if ctxErr := ctx.Err(); ctxErr != nil {
		result.ExitCode = -1
		result.TimedOut = errors.Is(ctxErr, context.DeadlineExceeded)
		return result, ctxErr
	}
	if err == nil {
		return result, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		result.ExitCode = exitErr.ExitCode()
		return result, nil
	}
	return result, fmt.Errorf("start child: %w", err)
}
