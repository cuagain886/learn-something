/*
═══════════════════════════════════════════════════════════════════

	18_packages —— 包与模块：Go 的代码组织体系

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. module（模块）与 package（包）的关系
 2. 如何导入自己项目里的包（看本目录的 shapes 子包！）
 3. 导入的各种形式：别名、空白导入
 4. init 函数与初始化顺序
 5. 第三方依赖管理常用命令

【运行】go run ./18_packages

【概念梳理】（容易混！）

	module 模块 = 一个项目 = go.mod 文件管辖的整棵目录树 = 版本管理的单位
	package 包  = 一个目录 = 编译和可见性的单位
	本项目：模块名 learn_go（见根目录 go.mod），
	        里面有 01_hello、shapes 等许多包。
	导入路径 = 模块名 + 从模块根到包目录的相对路径：
	        "learn_go/18_packages/shapes"
*/
package main

// ───────────────────────────────────────────────────────────────
// 导入的各种形式
// ───────────────────────────────────────────────────────────────
import (
	"fmt" // 标准库：直接写包名

	// 本模块内的包：模块名/相对路径 ★这就是导入自己代码的方式
	"learn_go/18_packages/shapes"

	// 起别名：路径最后一段冲突或太长时使用
	sh "learn_go/18_packages/shapes" // 现在 sh.Pi 和 shapes.Pi 等价
	// （这里仅为演示同一个包导入两个名字；真实代码不会这么做）
	// 空白导入 _：只执行包的 init 函数，不使用其任何标识符。
	// 经典场景：数据库驱动注册 _ "github.com/go-sql-driver/mysql"
	// _ "image/png"  // 注册 PNG 解码器给 image 包用
	// 第三方包：导入路径就是代码仓库地址，例如
	// "github.com/google/uuid"
	// 使用前先在项目根目录执行: go get github.com/google/uuid
)

// ───────────────────────────────────────────────────────────────
// init 函数：包加载时自动执行的初始化钩子
// ───────────────────────────────────────────────────────────────
//   - 不能被显式调用，没有参数和返回值；一个文件可以有多个 init
//   - 执行顺序：被依赖的包先初始化 ->
//     包级变量求值 -> init() -> 然后才轮到 main()
//   - ⚠️ 慎用：init 里的隐式行为难以测试和追踪，能用显式初始化就别用 init
var bootTime = initBootMessage() // 包级变量在 init 之前求值

func initBootMessage() string {
	fmt.Println("(1) 包级变量先初始化")
	return "已启动"
}

func init() {
	fmt.Println("(2) init() 其次执行")
}

func main() {
	fmt.Println("(3) main() 最后执行，bootTime =", bootTime)

	fmt.Println("\n══════ 1. 使用自己写的包 ══════")
	// 用 包名.标识符 访问 shapes 包导出的内容
	fmt.Println("shapes.Pi =", shapes.Pi)

	// 工厂函数 + 错误处理（shapes 包内部做了校验）
	r, err := shapes.NewRect(3, 4)
	if err != nil {
		fmt.Println("创建失败:", err)
		return
	}
	fmt.Printf("%s: %v x %v 面积 = %v\n", r.Label(), r.Width, r.Height, r.Area())

	// 非法参数会得到包导出的哨兵错误
	_, err = shapes.NewRect(-1, 5)
	fmt.Println("负数尺寸:", err)

	// 圆面积（内部用了包的未导出函数 round —— 我们看不见它，这就是封装）
	area, _ := shapes.CircleArea(2)
	fmt.Println("半径 2 的圆面积 =", area)

	// 别名导入照常工作
	fmt.Println("通过别名访问: sh.Pi =", sh.Pi)

	// ⚠️ 未导出的标识符在包外无法访问，以下全是编译错误：
	// shapes.defaultPrecision   // 未导出常量
	// shapes.round(1.234, 2)    // 未导出函数
	// r.label                   // 未导出字段

	fmt.Println("\n══════ 2. go.mod 与依赖管理速查 ══════")
	fmt.Println(`  go mod init <模块名>   创建模块（模块名惯例用仓库地址）
  go get <包路径>        添加/升级第三方依赖（写入 go.mod）
  go get <包路径>@v1.2.3 安装指定版本
  go mod tidy            清理：补全缺的、删掉没用的依赖 ★常用
  go list -m all         列出全部依赖
  （go.sum 记录依赖的校验和，保证可重现构建，连同 go.mod 一起提交）`)

	fmt.Println("\n══════ 3. 项目布局惯例（社区约定）══════")
	fmt.Println(`  myproject/
  ├── go.mod
  ├── cmd/myapp/main.go      可执行入口（可有多个 cmd/xxx）
  ├── internal/...           私有包：★只有本模块能导入，编译器强制！
  ├── pkg/...                有人用它放公开库（争议惯例，非官方）
  └── 其他按领域划分的包目录
  原则：按【功能领域】分包（user/order/payment），
        不要按"类型"分包（models/utils/helpers 是反模式）；
        包名就是 API 的一部分：shapes.NewRect 读起来通顺即可。`)
}
