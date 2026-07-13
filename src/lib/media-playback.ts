// Detects videos that browsers (especially desktop Chrome/Firefox) likely cannot decode,
// so the UI can offer a "download to view" hint instead of a silently-black <video> element.
// iPhones commonly record HEVC/H.265 in .mov / video/quicktime containers, which Chrome and
// Firefox refuse to play. Be conservative: mp4/webm are broadly supported and stay `false`.
// Mirrors Check Time's isBrowserUnsafeVideo predicate.

const UNSAFE_MIME = new Set([
  'video/quicktime',
  'video/x-matroska',
])

const UNSAFE_EXTENSIONS = ['.mov', '.hevc', '.h265', '.mkv', '.avi']

// Returns true when the container/codec is a common one browsers struggle to decode.
// Detection uses whatever the component already loaded (mime and/or filename); either may be absent.
export function isBrowserUnsafeVideo(opts: { mime?: string | null; filename?: string | null }): boolean {
  const mime = opts.mime?.trim().toLowerCase()
  if (mime && UNSAFE_MIME.has(mime)) return true

  const filename = opts.filename?.trim().toLowerCase()
  if (filename && UNSAFE_EXTENSIONS.some((ext) => filename.endsWith(ext))) return true

  return false
}
