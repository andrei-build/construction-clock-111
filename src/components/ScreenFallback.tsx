// PERF-1: лёгкий фолбэк для <Suspense> вокруг лениво загружаемых экранов.
// Переиспользует существующий .spinner (styles.css) — мгновенный, в стиле приложения,
// без текста (не мигает на быстрых чанках, i18n не нужен).
export default function ScreenFallback() {
  return <div className="spinner">…</div>
}
