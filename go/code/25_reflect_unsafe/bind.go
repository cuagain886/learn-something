package main

import (
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"time"
)

var (
	ErrInvalidTarget   = errors.New("bind target must be a non-nil pointer to a struct")
	ErrInvalidTag      = errors.New("invalid cfg tag")
	ErrRequiredField   = errors.New("required configuration value is missing")
	ErrUnsupportedType = errors.New("unsupported configuration field type")
	ErrUnexportedField = errors.New("cfg tag is not allowed on an unexported field")
)

type FieldError struct {
	Field string
	Key   string
	Value string
	Err   error
}

func (e *FieldError) Error() string {
	if e.Value == "" {
		return fmt.Sprintf("configuration field %s (%s): %v", e.Field, e.Key, e.Err)
	}
	return fmt.Sprintf("configuration field %s (%s=%q): %v", e.Field, e.Key, e.Value, e.Err)
}

func (e *FieldError) Unwrap() error { return e.Err }

type tagOptions struct {
	key          string
	required     bool
	hasDefault   bool
	defaultValue string
}

var durationType = reflect.TypeFor[time.Duration]()

type Signed interface {
	~int | ~int8 | ~int16 | ~int32 | ~int64
}

func ParseSigned[T Signed](raw string) (T, error) {
	var zero T
	value, err := strconv.ParseInt(raw, 10, reflect.TypeFor[T]().Bits())
	if err != nil {
		return zero, err
	}
	return T(value), nil
}

func Bind(target any, values map[string]string) error {
	targetValue := reflect.ValueOf(target)
	if !targetValue.IsValid() || targetValue.Kind() != reflect.Pointer || targetValue.IsNil() {
		return ErrInvalidTarget
	}
	structValue := targetValue.Elem()
	if structValue.Kind() != reflect.Struct {
		return ErrInvalidTarget
	}
	return bindStruct(structValue, values)
}

func bindStruct(structValue reflect.Value, values map[string]string) error {
	structType := structValue.Type()
	for index := range structType.NumField() {
		fieldType := structType.Field(index)
		rawTag, tagged := fieldType.Tag.Lookup("cfg")
		if !tagged {
			field := structValue.Field(index)
			if fieldType.PkgPath == "" && field.Kind() == reflect.Struct && field.Type() != durationType {
				if err := bindStruct(field, values); err != nil {
					return err
				}
			}
			continue
		}
		if fieldType.PkgPath != "" {
			return &FieldError{Field: fieldType.Name, Err: ErrUnexportedField}
		}

		options, err := parseTag(rawTag)
		if err != nil {
			return &FieldError{Field: fieldType.Name, Err: err}
		}
		rawValue, found := values[options.key]
		if !found && options.hasDefault {
			rawValue, found = options.defaultValue, true
		}
		if !found {
			if options.required {
				return &FieldError{Field: fieldType.Name, Key: options.key, Err: ErrRequiredField}
			}
			continue
		}
		if err := setField(structValue.Field(index), rawValue); err != nil {
			return &FieldError{Field: fieldType.Name, Key: options.key, Value: rawValue, Err: err}
		}
	}
	return nil
}

func parseTag(raw string) (tagOptions, error) {
	parts := strings.Split(raw, ",")
	options := tagOptions{key: strings.TrimSpace(parts[0])}
	if options.key == "" {
		return tagOptions{}, ErrInvalidTag
	}
	for _, rawOption := range parts[1:] {
		option := strings.TrimSpace(rawOption)
		switch {
		case option == "required":
			options.required = true
		case strings.HasPrefix(option, "default="):
			if options.hasDefault {
				return tagOptions{}, ErrInvalidTag
			}
			options.hasDefault = true
			options.defaultValue = strings.TrimPrefix(option, "default=")
		default:
			return tagOptions{}, ErrInvalidTag
		}
	}
	if options.required && options.hasDefault {
		return tagOptions{}, ErrInvalidTag
	}
	return options, nil
}

func setField(field reflect.Value, raw string) error {
	if field.Type() == durationType {
		value, err := time.ParseDuration(raw)
		if err != nil {
			return err
		}
		field.SetInt(int64(value))
		return nil
	}

	switch field.Kind() {
	case reflect.String:
		field.SetString(raw)
	case reflect.Bool:
		value, err := strconv.ParseBool(raw)
		if err != nil {
			return err
		}
		field.SetBool(value)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		value, err := strconv.ParseInt(raw, 10, field.Type().Bits())
		if err != nil {
			return err
		}
		field.SetInt(value)
	default:
		return ErrUnsupportedType
	}
	return nil
}
