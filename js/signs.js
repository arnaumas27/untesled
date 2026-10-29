/**
 * signs.js — the artwork for each sound: a neon sign with a line icon, the
 * vehicle's name in neon-tube lettering and a short subtitle.
 *
 * The sign is drawn twice, stacked: unlit glass tubes underneath and the lit
 * tubes on top. The UI only changes the lit layer's opacity, so flickering on
 * at start-up, pulsing with the throttle and dimming at shutdown are cheap.
 *
 * Icons are 24 × 24 line drawings. The superbike, plane and horse come from
 * Hugeicons (MIT licence, https://hugeicons.com, see assets/LICENSE-hugeicons.txt);
 * the 911, the fastback and the freighter are drawn in the same style for
 * Untesled.
 */

const ICONS = {
  gt3: `<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 17.8C1 16.8 .9 15.2 1.3 14.3C1.6 13.7 2.2 13.4 3 13.3C5 12.9 7.2 11 9.8 10.1C10.6 9.8 11.5 9.7 12.3 9.8C13.6 10 14.6 11.4 16 12.8C18.5 13 21.2 13.6 22.3 14.3C23 14.8 23.1 16.5 22.8 17.8H20.9A3.2 3.2 0 0 0 14.7 17.8H9.3A3.2 3.2 0 0 0 3.1 17.8Z"/><path d="M7.8 13.1C9.8 13.2 12.9 13.1 15.2 13"/><path d="M1.1 11.1H5M4.3 11.1L4.7 12.5"/><circle cx="6.2" cy="17" r="2.2"/><circle cx="17.8" cy="17" r="2.2"/></g>`,
  muscle: `<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M.9 17.8L.8 13.6L.6 12.9L1.8 12.8L9.5 9.9C10.6 9.6 11.6 9.6 12.4 9.9L14.9 12.1L22.5 12.7C22.9 12.8 23.2 13.1 23.2 13.6V16.9C23.2 17.4 23 17.8 22.6 17.8H21.3A3.2 3.2 0 0 0 15.1 17.8H8.7A3.2 3.2 0 0 0 2.5 17.8Z"/><path d="M7.2 12.9H14.6"/><path d="M17.3 12.3V11.5H19.3V12.4"/><circle cx="5.6" cy="17" r="2.2"/><circle cx="18.2" cy="17" r="2.2"/></g>`,
  freighter: `<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17.3 9.6H22V11.4H15.5V12.6H22V14.4H17.3A7.2 7.2 0 1 1 17.3 9.6Z"/><circle cx="10.5" cy="12" r="2.3"/><path d="M14.9 17.8L16.4 18.2"/><circle cx="17.9" cy="18.6" r="1.5"/><path d="M4.3 8.4A6.2 6.2 0 0 0 4.3 15.6"/></g>`,
  motorbike: `<g fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="19.5" cy="16.5" r="2.5"/><circle cx="4.5" cy="16.5" r="2.5"/><path stroke-linecap="round" stroke-linejoin="round" d="M20.235 7.87c1.281 1.559 1.727 3.042 1.764 3.826a5.3 5.3 0 0 0-2.217-.479c-2.445 0-4.64 1.626-5.164 3.792c-.126.518-.188.777-.324.884s-.356.107-.795.107h-2.878c-.443 0-.664 0-.8-.108c-.137-.11-.197-.367-.316-.883c-.496-2.138-2.508-3.997-4.603-3.84c-.211.017-.317.025-.39.008c-.071-.016-.144-.057-.29-.14c-.421-.237-.851-.463-1.264-.714A2 2 0 0 1 2 8.683c-.013-.384.207-.764.652-.66l6.42 1.511c.483.114.724.17.931.132s.462-.212.97-.56c1.288-.88 3.33-1.713 5.365-.978c.557.201.836.302.994.307c.16.005.392-.063.857-.198a9.5 9.5 0 0 1 2.045-.367m0 0c-.802-.978-1.934-1.985-3.5-2.87"/></g>`,
  airplane: `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path d="M10 9.5L5.275 4.476c-.418-.452-.351-.781.142-1.066c.928-.537 1.65-.551 2.627-.015l4.905 2.692c.35.191.692.386 1.051.492m-1.5 7.084l2.11 6.807c.173.556.476.656.946.387c.884-.507 1.24-1.092 1.264-2.146l.12-5.291c.015-.707.013-1.399.56-1.92"/><path d="m8.328 10.984l1.887-1.378l4.429-3.229s1.635-1.201 2.548-1.601c1.084-.475 2.095-.254 3.182.05c.562.156.843.235 1.046.381c.322.233.531.59.574.982c.027.246-.044.526-.187 1.085h0c-.278 1.08-.589 2.054-1.548 2.744c-.808.58-2.68 1.377-2.68 1.377l-5.047 2.17l-2.154.923h0c-.78.334-1.171.502-1.437.812c-.622.727-.71 2.044-.942 2.95c-.128.5-.832 1.367-1.458 1.237c-.387-.08-.395-.565-.443-.874l-.464-2.974c-.11-.711-.12-.726-.688-1.176l-2.378-1.884c-.247-.195-.669-.444-.546-.815c.2-.6 1.312-.768 1.815-.628c.911.255 2.11.838 3.06.67c.405-.072.747-.322 1.431-.822"/></g>`,
  horse: `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"><path stroke-linejoin="round" d="m19.5 4.5l2.5 4c-.274.548-.887 1-1.5 1L19 8c-.896 0-1.717-.65-2-1.5M18.5 2l-1 1c-2 .5-3.312 1.936-3.834 3.502L13 8.5c-2.152 1.537-3.682 1.184-5.311.684c-1.034-.317-2.216-.157-2.98.607A2.42 2.42 0 0 0 4 11.503V21m.5-11.5l-.744-.372A1.213 1.213 0 0 0 2 10.213V14m15.5-6.5l-.097.146a3.1 3.1 0 0 0-.299 2.865a3.6 3.6 0 0 1 .187 2.034c-.186.931-1 1.928-1.791 2.455v6"/><path d="M13 21v-6.5"/><path stroke-linejoin="round" d="M8 16s2.308 1.125 5 0"/><path stroke-linejoin="round" d="M8.5 14.5c-.5 2-2 2.5-2 2.5v4"/></g>`,
};

export const SIGNS = {
  flat6: { icon: 'gt3', title: '911 GT3', sub: 'Flat six · 9,000 rpm', color: '#1fc6ff' },
  v8: { icon: 'muscle', title: "Mustang '70", sub: 'V8 · 3-speed automatic', color: '#ff7a1f' },
  moto: { icon: 'motorbike', title: 'Superbike', sub: 'Inline four · 14,000 rpm', color: '#ff2bd0' },
  jet: { icon: 'airplane', title: 'CFM56', sub: 'Turbofan · takeoff thrust', color: '#9a7bff' },
  freighter: { icon: 'freighter', title: 'Hyperdrive', sub: 'Space freighter', color: '#2fffd0' },
  carriage: { icon: 'horse', title: 'Horse carriage', sub: 'One horsepower', color: '#ffad24' },
};

const sign = (id) => SIGNS[id] || SIGNS.flat6;

/** The icon on its own (Settings thumbnails). */
export function iconSvg(id, cls = '') {
  const s = sign(id);
  return `<svg class="${cls}" viewBox="0 0 24 24" style="--c:${s.color}" aria-hidden="true" focusable="false">${ICONS[s.icon]}</svg>`;
}

/** Markup for the full sign: unlit tubes plus the lit layer the UI fades in. */
export function signHtml(id) {
  const s = sign(id);
  const face = (cls) =>
    `<div class="sign-face ${cls}"${cls === 'sign-on' ? '' : ' aria-hidden="true"'}>` +
    `<svg class="sign-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[s.icon]}</svg>` +
    `<div class="sign-title">${s.title}</div><div class="sign-sub">${s.sub}</div></div>`;
  return `<div class="sign" style="--c:${s.color}">${face('sign-off')}${face('sign-on')}</div>`;
}
