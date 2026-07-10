/* 33_channel_select_semaphore —— hchan、select、runtime semaphore 与 Cond。 */
package main

import (
	"flag"
	"fmt"
)

func main() {
	iterations := flag.Int("iterations", 10000, "ready select observations")
	flag.Parse()
	q := NewCondQueue[int]()
	q.Push(1)
	q.Push(2)
	q.Close()
	for {
		v, ok := q.Pop()
		if !ok {
			break
		}
		fmt.Println("drain", v)
	}
	stats, err := MeasureReadySelect(*iterations)
	fmt.Printf("ready-select=%+v err=%v (distribution is observation, not a guarantee)\n", stats, err)
}
