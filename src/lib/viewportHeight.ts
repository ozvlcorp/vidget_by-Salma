/**
 * Высота экрана на телефоне.
 *
 * Safari на iPhone считает `100vh` по экрану БЕЗ своей нижней панели, поэтому
 * приложение получается выше видимой области: нижние вкладки и кнопка «Создать»
 * уезжают под панель браузера. Единица `dvh` это чинит, но появилась только в
 * iOS 16.4 — на iPhone постарше её нет.
 *
 * Поэтому подставляем реальную высоту (`window.innerHeight`, у Safari это как
 * раз видимая часть) в переменную --app-vh. Там, где `dvh` поддерживается,
 * @supports в index.css её перекрывает, и JS ни на что не влияет.
 */
export function installViewportHeight() {
  const apply = () => {
    document.documentElement.style.setProperty('--app-vh', `${window.innerHeight}px`)
  }
  apply()
  window.addEventListener('resize', apply)
  // Поворот экрана: Safari сообщает новую высоту не сразу после события.
  window.addEventListener('orientationchange', () => setTimeout(apply, 200))
}
