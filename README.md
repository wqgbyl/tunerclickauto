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
