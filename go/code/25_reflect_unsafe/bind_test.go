package main

import (
	"errors"
	"runtime"
	"testing"
	"time"
	"unsafe"
)

type testConfig struct {
	Addr    string        `cfg:"ADDR,required"`
	Port    int           `cfg:"PORT,default=8080"`
	Debug   bool          `cfg:"DEBUG,default=false"`
	Timeout time.Duration `cfg:"TIMEOUT,default=2s"`
}

func TestBindAppliesValuesAndDefaults(t *testing.T) {
	var config testConfig
	err := Bind(&config, map[string]string{
		"ADDR":  "127.0.0.1",
		"DEBUG": "true",
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.Addr != "127.0.0.1" || config.Port != 8080 || !config.Debug || config.Timeout != 2*time.Second {
		t.Fatalf("Bind() config = %+v", config)
	}
}

func TestBindReportsMissingRequiredField(t *testing.T) {
	var config testConfig
	err := Bind(&config, nil)
	var fieldErr *FieldError
	if !errors.As(err, &fieldErr) {
		t.Fatalf("Bind() error = %T %v, want *FieldError", err, err)
	}
	if fieldErr.Field != "Addr" || fieldErr.Key != "ADDR" {
		t.Fatalf("FieldError = %+v, want field Addr key ADDR", fieldErr)
	}
}

func TestBindTraversesNestedStructs(t *testing.T) {
	type databaseConfig struct {
		Host string `cfg:"DB_HOST,required"`
		Port int    `cfg:"DB_PORT,default=5432"`
	}
	type applicationConfig struct {
		Name     string `cfg:"NAME,default=demo"`
		Database databaseConfig
	}

	var config applicationConfig
	err := Bind(&config, map[string]string{"DB_HOST": "db.internal"})
	if err != nil {
		t.Fatal(err)
	}
	if config.Name != "demo" || config.Database.Host != "db.internal" || config.Database.Port != 5432 {
		t.Fatalf("Bind() nested config = %+v", config)
	}
}

func TestBindRejectsInvalidTargets(t *testing.T) {
	var nilConfig *testConfig
	value := 42
	targets := []any{nil, testConfig{}, nilConfig, &value}
	for index, target := range targets {
		if err := Bind(target, nil); !errors.Is(err, ErrInvalidTarget) {
			t.Fatalf("case %d: Bind() = %v, want ErrInvalidTarget", index, err)
		}
	}
}

func TestBindReportsConversionAndSchemaErrors(t *testing.T) {
	tests := []struct {
		name   string
		target any
		values map[string]string
		want   error
	}{
		{
			name: "invalid bool",
			target: &struct {
				Value bool `cfg:"VALUE"`
			}{},
			values: map[string]string{"VALUE": "sometimes"},
		},
		{
			name: "integer overflow",
			target: &struct {
				Value int8 `cfg:"VALUE"`
			}{},
			values: map[string]string{"VALUE": "1000"},
		},
		{
			name: "invalid duration",
			target: &struct {
				Value time.Duration `cfg:"VALUE"`
			}{},
			values: map[string]string{"VALUE": "soon"},
		},
		{
			name: "unsupported slice",
			target: &struct {
				Value []string `cfg:"VALUE"`
			}{},
			values: map[string]string{"VALUE": "a,b"},
			want:   ErrUnsupportedType,
		},
		{
			name: "unknown option",
			target: &struct {
				Value string `cfg:"VALUE,secret"`
			}{},
			want: ErrInvalidTag,
		},
		{
			name: "required conflicts with default",
			target: &struct {
				Value string `cfg:"VALUE,required,default=x"`
			}{},
			want: ErrInvalidTag,
		},
		{
			name: "tagged unexported field",
			target: &struct {
				value string `cfg:"VALUE"`
			}{},
			want: ErrUnexportedField,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := Bind(tt.target, tt.values)
			if err == nil {
				t.Fatal("Bind() error = nil, want error")
			}
			var fieldErr *FieldError
			if !errors.As(err, &fieldErr) {
				t.Fatalf("Bind() error = %T %v, want *FieldError", err, err)
			}
			if tt.want != nil && !errors.Is(err, tt.want) {
				t.Fatalf("Bind() error = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestSafeBytesToStringCopiesData(t *testing.T) {
	source := []byte("Go")
	converted := SafeBytesToString(source)
	source[0] = 'N'
	if converted != "Go" {
		t.Fatalf("SafeBytesToString() = %q after source mutation, want Go", converted)
	}
}

func TestUnsafeBytesToReadOnlyStringSharesData(t *testing.T) {
	source := []byte("zero-copy")
	converted := UnsafeBytesToReadOnlyString(source)
	if converted != "zero-copy" {
		t.Fatalf("UnsafeBytesToReadOnlyString() = %q", converted)
	}
	if unsafe.StringData(converted) != unsafe.SliceData(source) {
		t.Fatal("unsafe conversion copied data, want shared data pointer")
	}
	runtime.KeepAlive(source)
	if got := UnsafeBytesToReadOnlyString(nil); got != "" {
		t.Fatalf("UnsafeBytesToReadOnlyString(nil) = %q, want empty", got)
	}
}

func TestLayoutOfMatchesUnsafePrimitives(t *testing.T) {
	type sample struct {
		Count int64
		Flag  bool
	}
	var value sample
	got := LayoutOf[sample]()
	if got.Size != unsafe.Sizeof(value) || got.Align != unsafe.Alignof(value) {
		t.Fatalf("LayoutOf[sample]() = %+v, want size=%d align=%d",
			got, unsafe.Sizeof(value), unsafe.Alignof(value))
	}
}

func TestParseSignedPreservesNamedTypeAndWidth(t *testing.T) {
	type Port int16
	got, err := ParseSigned[Port]("8080")
	if err != nil {
		t.Fatal(err)
	}
	if got != Port(8080) {
		t.Fatalf("ParseSigned[Port]() = %v, want 8080", got)
	}
	if _, err := ParseSigned[int8]("1000"); err == nil {
		t.Fatal("ParseSigned[int8](1000) error = nil, want overflow")
	}
}
