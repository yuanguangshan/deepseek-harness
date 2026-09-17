/** `settings.theme` namespace dictionaries (the Appearance, font-size, and background-image rows' copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'appearance.title': '外观',
  'appearance.light': '浅色',
  'appearance.dark': '深色',
  'appearance.system': '跟随系统',
  'fontSize.title': '字号大小',
  'fontSize.description': '仅影响会话内容的字号',
  'fontSize.unit': 'px',
  'fontSize.increase': '增大字号',
  'fontSize.decrease': '减小字号',
  'wallpaper.title': '背景图片',
  'wallpaper.description': '为整个界面添加自定义背景图片',
  'wallpaper.choose': '选择图片',
  'wallpaper.replace': '更换图片',
  'wallpaper.remove': '移除',
  'wallpaper.opacity': '透明度',
  'wallpaper.blur': '模糊',
  'wallpaper.percentUnit': '%',
  'wallpaper.pixelUnit': 'px',
  'wallpaper.errorTooLarge': '图片文件过大，请选择 20 MB 以内的图片',
  'wallpaper.errorUnsupported': '无法读取该图片格式',
} satisfies Record<string, string>

/** The settings.theme namespace key union. */
export type ThemeKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'appearance.title': 'Appearance',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.system': 'System',
  'fontSize.title': 'Font size',
  'fontSize.description': 'Only affects conversation content',
  'fontSize.unit': 'px',
  'fontSize.increase': 'Increase font size',
  'fontSize.decrease': 'Decrease font size',
  'wallpaper.title': 'Background image',
  'wallpaper.description': 'Add a custom background image to the whole interface',
  'wallpaper.choose': 'Choose image',
  'wallpaper.replace': 'Replace image',
  'wallpaper.remove': 'Remove',
  'wallpaper.opacity': 'Opacity',
  'wallpaper.blur': 'Blur',
  'wallpaper.percentUnit': '%',
  'wallpaper.pixelUnit': 'px',
  'wallpaper.errorTooLarge': 'Image is too large; choose one under 20 MB',
  'wallpaper.errorUnsupported': 'This image format cannot be read',
} satisfies Record<ThemeKey, string>
