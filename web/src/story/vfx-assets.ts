import arcaneParry from "~/assets/vfx/arcane-parry.png?inline";
import bloodSplatter01 from "~/assets/vfx/blood-splatter-01.png?inline";
import bloodSplatter02 from "~/assets/vfx/blood-splatter-02.png?inline";
import crescentSlash from "~/assets/vfx/crescent-slash.png?inline";
import electricImpact from "~/assets/vfx/electric-impact.png?inline";
import magicalProjectile from "~/assets/vfx/magical-projectile.png?inline";
import radiantHeal from "~/assets/vfx/radiant-heal.png?inline";
import rainField from "~/assets/vfx/rain-field.png?inline";
import rainOverlay from "~/assets/vfx/rain-overlay.png?inline";
import bulletStrip from "~/assets/vfx/bullet-strip.png?inline";
import bloodLensOverlay from "~/assets/vfx/health-splats-cc0.png?inline";
import lensRaindrops from "~/assets/vfx/raindrops-window-cc0.webp?inline";

/** CC0 assets embedded as data URLs so exported HTML remains fully offline. */
export const vfxAssets = {
	arcaneParry,
	bloodSplatter01,
	bloodSplatter02,
	crescentSlash,
	electricImpact,
	magicalProjectile,
	radiantHeal,
	rainField,
	rainOverlay,
	bulletStrip,
	bloodLensOverlay,
	lensRaindrops,
} as const;

export type VfxAssetName = keyof typeof vfxAssets;
