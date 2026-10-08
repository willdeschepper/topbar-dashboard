// SPDX-License-Identifier: GPL-2.0-or-later
// Tamanhos do dashboard
export const CARD_WIDTH = 880;
export const PAGE_HEIGHT = 390;

// Raio da curva invertida que "cola" o painel na barra
export const EAR_RADIUS = 24;

// Cor de fundo da barra e do dashboard.
// Precisa ser a mesma de .wdt-card e #panel.wdt-panel no stylesheet.css (#141218)
export const BG_RGB = [0x14 / 255, 0x12 / 255, 0x18 / 255];

// Cidade do clima e consumo máximo do processador ficam nas preferências da extensão.

// ---------------------------------------------------------------- Modo vidro
// Liga sozinho quando o Blur my Shell desfoca a barra.

// true  = desfoque e brilho vêm do Blur my Shell (Preferências > Panel), ao vivo
// false = usa os valores de GLASS_BLUR abaixo
export const GLASS_FROM_BMS = true;

// Usado quando GLASS_FROM_BMS = false (ou se a leitura do Blur my Shell falhar)
export const GLASS_BLUR = {
    radius: 30,       // desfoque (mais alto = mais borrado)
    brightness: 0.6,  // brilho do fundo (0 = preto, 1 = original)
};

// Cor extra por cima do blur: [vermelho, verde, azul, opacidade], de 0 a 1.
// Opacidade 0 = painel com o mesmo tom da barra. Suba (ex.: 0.3) para escurecer mais.
export const GLASS_TINT = [0.08, 0.07, 0.09, 0];
