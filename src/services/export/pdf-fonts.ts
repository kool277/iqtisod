import boldUrl from '../../assets/fonts/NotoSans-Bold.subset.ttf?url'
import regularUrl from '../../assets/fonts/NotoSans-Regular.subset.ttf?url'
import { bytesToBase64 } from '../../crypto/encoding'

export type PdfFonts = { regular: string; bold: string }

async function fetchBase64(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Font ${url} failed to load`)
  return bytesToBase64(new Uint8Array(await response.arrayBuffer()))
}

export async function loadPdfFonts(): Promise<PdfFonts> {
  const [regular, bold] = await Promise.all([fetchBase64(regularUrl), fetchBase64(boldUrl)])
  return { regular, bold }
}
