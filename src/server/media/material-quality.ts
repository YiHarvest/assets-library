import { AppError } from "@/server/errors";

/** 只识别明确无画面的描述；无人、暗色、抽象画面并不等于无效素材。 */
export function unusableVisualReason(description: string) {
  const text = description.replace(/[\s的]/gu, "");
  // 局部黑屏、片头片尾过渡不能据此判定整条素材无效。
  if (/(?:片头|片尾|开头|结尾|局部|短暂|随后|之后|后出现|转为|切换|部分画面)/u.test(text)) return null;
  const empty = /(?:无|没有|未见)(?:任何|可见|可辨识|可识别|有效|具体|视觉)*(?:内容|元素|物体|主体|细节|信息)|没有人物或可见文字/u.test(text);
  const blank = /(?:画面|图像|图片|视频|素材)(?:呈现为|呈现|显示为|为|是|处于|始终|全程|完全|均为|全部为)*(?:全黑|纯黑|全白|纯白|黑屏|白屏|空白|纯色)|^(?:纯黑|纯白)(?:色)?(?:图像|画面|图片|视频)/u.test(text);
  if ((blank && empty) || /^(?:(?:视频|图片|图像|画面)(?:呈现为|全程|为|是)*)(?:全黑|纯黑|全白|纯白|黑屏|白屏|空白)(?:画面)?[。！.!]*$/u.test(text))
    return "黑屏、空白或纯色画面，没有可用视觉内容。";
  if (/^(?:标准)?(?:电视)?(?:测试卡|测试信号)|(?:画面|视频|图像)(?:全程)?(?:仅有|只有|全是|仅为)(?:随机)?(?:噪点|雪花|噪声|杂乱色块)/u.test(text))
    return "测试信号或纯噪声，没有可用视觉内容。";
  if (empty && /(?:完全遮挡|严重模糊|完全模糊|无法辨认任何|无法识别任何)/u.test(text))
    return "画面不可辨识，没有可用视觉内容。";
  return null;
}

export class UnusableMaterialError extends AppError {
  constructor(reason: string) {
    super("invalid_request", `素材不合格：${reason}`, 400, { reason: "unusable_visual_content" });
  }
}
