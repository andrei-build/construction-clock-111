import { useEffect, useRef } from 'react'

// LIVE-REFRESH-1: браузерный хук «живых данных» для экранов владельца (закон Андрея 17.07 —
// «приложение должно обновляться максимально часто, чтобы я его не перезагружал»).
//
// Делает две вещи, БЕЗ новых api-запросов (переиспользует переданный refetch — существующую
// load-функцию экрана):
//   1) вызывает refetch при возврате на вкладку (visibilitychange → visible) и при window focus;
//   2) если задан pollMs — мягко поллит refetch раз в pollMs, но ТОЛЬКО пока вкладка видима
//      (в фоне не долбим сеть).
//
// Это НЕ api-хелпер, а чистый браузерный хук: только слушатели document/window + таймер, всё
// снимается в cleanup. refetch ОБЯЗАН быть фоновым — не показывать глобальный спиннер и не
// сбрасывать ввод/модалки/скролл (за это отвечает вызывающий экран, обычно передавая silent-режим
// своей load-функции). refetch держим в ref, поэтому эффект не переподписывается на каждый рендер
// и слушатели/таймер стабильны, даже если экран передаёт новую стрелку каждый раз.
export function useLiveRefresh(refetch: () => void, pollMs?: number): void {
  const refetchRef = useRef(refetch)
  refetchRef.current = refetch

  useEffect(() => {
    const run = () => refetchRef.current()
    const onVisible = () => { if (document.visibilityState === 'visible') run() }

    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', run)

    let timer: number | undefined
    if (pollMs && pollMs > 0) {
      timer = window.setInterval(() => {
        if (document.visibilityState === 'visible') run()
      }, pollMs)
    }

    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', run)
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [pollMs])
}
