# 录音前设定 BPM + 录音中节拍器（声音+闪灯）V6

## 你要的行为
- 录音开始前手动设定 ♩BPM
- 点击“开始录音”后：
  - 节拍器持续响（可调音量）
  - 绿灯：每个正拍亮；半拍弱闪（用于视觉提示快慢）
- 录完可回放（可选叠加节拍器）

## 运行
本地：
```bash
npx http-server -p 5173
```
打开 http://localhost:5173

GitHub Pages：
Settings → Pages → Deploy from a branch → main → /(root)

## 说明
- 录音文件本身不会“直接混入”节拍器（因为录的是麦克风输入），但如果你外放很大声，麦克风仍可能拾到节拍器声。

## AI 接入（GitHub Models / Azure AI Inference）
> 下面示例是 **Python 后端** 调用方式，请勿把 Token 放到前端（浏览器端）代码里。

### 1) 安装依赖
```bash
python -m pip install azure-ai-inference azure-core
```

### 2) 准备 Token
将 GitHub Models 的访问 Token 设为环境变量：
```bash
export GITHUB_TOKEN="YOUR_TOKEN_HERE"
```

### 3) 运行示例脚本
仓库已放一个最小示例脚本：
```bash
python scripts/github-models-demo.py
```

### 4) 你的下一步
如果要在本专案里“接入 AI”，建议做法是：
- 在你的服务器端新增一个 API（Node/Python/Go 都可以）
- API 内部调用 `azure.ai.inference`（或对应 SDK）
- 前端只调用你自己的 API，避免暴露 Token
