import { Color, SRGBColorSpace } from 'three/webgpu'

/**
 * Six key colors of a stratigraphic column, deepest bed first: core redbed, sandstone, siltstone, shale, caprock,
 * and the aeolian sand that fills the troughs. Beds between them are mixed from these.
 */
export type FoldPalette = readonly [string, string, string, string, string, string]

export const FOLD_PALETTES: Record<string, FoldPalette> = {
  'Coyote Buttes': ['#6e1d12', '#b9482a', '#df8f45', '#b89a78', '#e3c9a6', '#d99c62'],
  'Painted Hills': ['#4a1714', '#a33a26', '#c99b45', '#57513d', '#dccfae', '#c79a63'],
  'San Rafael Swell': ['#7c2f1d', '#c0643a', '#d9a560', '#8d8566', '#e8dcc2', '#dcb27c'],
  'Zagros': ['#5b3d33', '#9d7b5d', '#c2a984', '#7a7563', '#ddd5c4', '#cdb08a'],
  'Sheep Mountain': ['#5f2a24', '#a8573c', '#c79458', '#6f6a5c', '#d8cdb7', '#c6a27a'],
}

export const DEFAULT_PALETTE = 'Coyote Buttes'

const color = new Color()

function hsl(hue: number, saturation: number, lightness: number) {
  return '#' + color.setHSL(((hue % 360) + 360) % 360 / 360, saturation, lightness, SRGBColorSpace).getHexString(SRGBColorSpace)
}

/**
 * A plausible desert column from a PRNG: hematite redbeds at the core, iron-stained sandstone, goethite ochre
 * siltstone, a shale of celadonite green, manganese purple or ash grey, a kaolinite-pale caprock, and sand
 * weathered out of the sandstone.
 */
export function randomPalette(random: () => number): FoldPalette {
  const iron = 4 + random() * 18
  const redbed = hsl(iron - 4 + random() * 8, 0.55 + random() * 0.25, 0.18 + random() * 0.1)
  const sandstone = hsl(iron + 6 + random() * 10, 0.5 + random() * 0.3, 0.38 + random() * 0.12)
  const siltstone = hsl(28 + random() * 16, 0.5 + random() * 0.25, 0.5 + random() * 0.12)
  const shaleKind = random()
  const shale = shaleKind < 0.4
    ? hsl(80 + random() * 60, 0.08 + random() * 0.14, 0.38 + random() * 0.14)
    : shaleKind < 0.7
      ? hsl(285 + random() * 50, 0.08 + random() * 0.14, 0.3 + random() * 0.12)
      : hsl(30 + random() * 20, 0.04 + random() * 0.08, 0.34 + random() * 0.16)
  const caprock = hsl(30 + random() * 15, 0.2 + random() * 0.3, 0.78 + random() * 0.1)
  const sand = hsl(iron + 16 + random() * 12, 0.45 + random() * 0.25, 0.6 + random() * 0.1)
  return [redbed, sandstone, siltstone, shale, caprock, sand]
}
