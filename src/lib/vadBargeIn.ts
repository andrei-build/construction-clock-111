// VOICE-FRONT-STREAM: ленивый загрузчик Silero-VAD (@ricky0123/vad-web) для barge-in — перебивания
// озвучки ассистента голосом. Тяжёлый onnxruntime-web + ONNX-модель грузятся ТОЛЬКО динамическим
// import при первом вооружении barge-in (не раздуваем основной бандл). Ассеты (worklet + silero.onnx
// + ort.wasm) тянем с CDN jsdelivr, чтобы не хостить их у себя и не копировать в dist. Любой сбой
// (нет сети/модели/AudioWorklet, старый браузер) → возвращаем null → приложение работает БЕЗ
// barge-in (graceful degradation), остальной голосовой цикл при этом цел.

// Версии закреплены под установленные в package.json (@ricky0123/vad-web + его peer onnxruntime-web),
// чтобы CDN-бинарь ort.wasm совпадал с бандлённым ort.js.
const VAD_WEB_VERSION = '0.0.30'
const ORT_WEB_VERSION = '1.27.0'
export const VAD_ASSET_BASE = `https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@${VAD_WEB_VERSION}/dist/`
export const ORT_WASM_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_WEB_VERSION}/dist/`

// Тонкая обёртка над MicVAD — наружу торчат только нужные команды жизненного цикла.
export interface BargeInVad {
  start: () => void
  pause: () => void
  destroy: () => void
}

export interface LoadBargeInVadOptions {
  // Дёргается, как только VAD услышал начало речи (кандидат на barge-in). Обработчик сам решает,
  // валиден ли момент (идёт ли озвучка/загрузка), и мгновенно глушит ответ.
  onSpeechStart: () => void
}

export async function loadBargeInVad(opts: LoadBargeInVadOptions): Promise<BargeInVad | null> {
  try {
    const mod = await import('@ricky0123/vad-web')
    const vad = await mod.MicVAD.new({
      baseAssetPath: VAD_ASSET_BASE,
      onnxWASMBasePath: ORT_WASM_BASE,
      model: 'legacy',
      startOnLoad: false,
      // Порог заметно выше дефолтного (0.3): собственная озвучка идёт через динамики, микрофон её
      // ловит — echoCancellation (в стриме VAD включён по умолчанию) гасит основное, а высокий порог
      // отсекает остаточное эхо, чтобы ассистент не «перебивал сам себя».
      positiveSpeechThreshold: 0.8,
      negativeSpeechThreshold: 0.5,
      // Быстрый отклик: короткий минимум речи и льгота, чтобы barge-in срабатывал почти мгновенно.
      minSpeechMs: 160,
      redemptionMs: 300,
      preSpeechPadMs: 160,
      onSpeechStart: () => { try { opts.onSpeechStart() } catch { /* защищаемся от исключений колбэка */ } },
    })
    return {
      start: () => { void Promise.resolve(vad.start()).catch(() => { /* ignore */ }) },
      pause: () => { void Promise.resolve(vad.pause()).catch(() => { /* ignore */ }) },
      destroy: () => { void Promise.resolve(vad.destroy()).catch(() => { /* ignore */ }) },
    }
  } catch (err) {
    console.warn('VAD barge-in unavailable', err)
    return null
  }
}
