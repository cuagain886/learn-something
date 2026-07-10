package main

func SumChecked(values []int) int {
	total := 0
	for index := 0; index < len(values); index++ {
		total += values[index]
	}
	return total
}

//go:noinline
func SumBCE(values []int) int {
	if len(values) == 0 {
		return 0
	}
	_ = values[len(values)-1]
	total := 0
	for index := 0; index < len(values); index++ {
		total += values[index]
	}
	return total
}

func InlineAdd(left, right int) int {
	return left + right
}

//go:noinline
func NoInlineAdd(left, right int) int {
	return left + right
}

func StackValue() int {
	value := 42
	return value
}

func EscapingValue() *int {
	value := 42
	return &value
}

type IntSource interface {
	Len() int
	At(int) int
}

type IntSlice []int

func (values IntSlice) Len() int         { return len(values) }
func (values IntSlice) At(index int) int { return values[index] }

func InterfaceSum(values IntSource) int {
	total := 0
	for index := 0; index < values.Len(); index++ {
		total += values.At(index)
	}
	return total
}

func GenericSum[S ~[]int](values S) int {
	total := 0
	for _, value := range values {
		total += value
	}
	return total
}
