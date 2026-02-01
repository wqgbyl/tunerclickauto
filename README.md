# 调音器 + 自动 BPM(♩) + 拍手定拍号/起拍 + 同步节拍器（AudioWorklet）V3

## 新增内容（你刚提的需求）
- ✅ 实时音准恢复（手机端能量门限下调）
- ✅ 报表恢复：平均|cents|、10/25 cents 内比例、Top5 音名分布
- ✅ “拍手定拍号/起拍”：
  - 开始录音后先等间隔拍手
  - 3下≈3/4，4下≈4/4
  - 若要更稳/避免起拍困扰：7下(3/4) 或 5下(4/4)（相当于多拍到下一次第一拍）
  - 系统检测稳定拍手后，优先用拍手锁定 BPM + 拍号 + 第一拍偏移
  - 若未检测到拍手或拍手不稳定，回退到自动节奏分析（谱通量+能量差分+ACF+相位估计）

## 运行
```bash
npx http-server -p 5173
```
打开 http://localhost:5173

## GitHub Pages
Settings → Pages → Deploy from a branch → main → /(root)

## 你要融合旧调音器
把你原项目成熟版本替换 `src/dsp/pitchTracker.js` 的实现即可，保持外部接口 `pushFrame(frame)`。
