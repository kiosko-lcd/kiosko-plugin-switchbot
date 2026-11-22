/**
 * SwitchBot thermometers, door and motion sensors on the panel, heard
 * straight from the computer's Bluetooth: what they broadcast, read without
 * a hub, the cloud or pairing, with a full-screen warning when a door is left
 * open.
 */
import { definePlugin } from '@kiosko/sdk';
import { L, LANGUAGES } from './i18n.ts';
import { devicesSource } from './source.ts';
import { WIDGETS } from './widgets.ts';

export { devicesSource } from './source.ts';
export { batteries, climate, doors, presence } from './widgets.ts';
export { decode } from './decode.ts';

export default definePlugin({
  id: 'switchbot',
  name: L('SwitchBot', 'SwitchBot', 'SwitchBot', 'SwitchBot', 'SwitchBot'),
  version: '0.1.0',
  description: L(
    'Your SwitchBot thermometers, door and motion sensors on the panel, heard straight from the computer\'s Bluetooth: no hub, no cloud, no pairing. With a full-screen warning when a door is left open.',
    'Tus termómetros, sensores de puerta y de movimiento SwitchBot en el panel, oídos directamente por el Bluetooth del ordenador: sin hub, sin nube y sin emparejar. Con un aviso a pantalla completa si una puerta se queda abierta.',
    'Deine SwitchBot-Thermometer, Tür- und Bewegungssensoren auf dem Panel, direkt über das Bluetooth des Computers gehört: ohne Hub, ohne Cloud, ohne Koppeln. Mit einer Vollbild-Warnung, wenn eine Tür offen bleibt.',
    '在副屏上查看你的 SwitchBot 温湿度计、门窗传感器和人体传感器，直接用电脑的蓝牙接收：无需网关、云端或配对。门忘关时全屏提醒。',
    '在面板上查看你的 SwitchBot 溫濕度計、門窗感測器和人體感測器，直接用電腦的藍牙接收：不必網關、雲端或配對。門忘了關時全螢幕提醒。',
  ),
  author: 'Loksly',
  license: 'MIT',
  homepage: 'https://github.com/kiosko-lcd/kiosko-plugin-switchbot#readme',
  repository: 'https://github.com/kiosko-lcd/kiosko-plugin-switchbot',
  icon: 'thermometer',
  sdk: '^0.2.0',
  platforms: ['linux'],
  languages: LANGUAGES,
  permissions: {
    exec: ['bluetoothctl', 'busctl'],
    devices: ['bluetooth'],
  },
  resources: { memoryMb: 15, cpu: 'low' },
  widgets: WIDGETS,
  sources: [devicesSource],
  templates: [
    {
      id: 'home',
      name: L('Home', 'Casa', 'Zuhause', '家', '家'),
      icon: 'house',
      wide: [
        { x: 0, y: 0, w: 0.5, h: 1, widgets: ['climate'] },
        { x: 0.5, y: 0, w: 0.25, h: 1, widgets: ['doors'] },
        { x: 0.75, y: 0, w: 0.25, h: 0.6, widgets: ['presence'] },
        { x: 0.75, y: 0.6, w: 0.25, h: 0.4, widgets: ['batteries'] },
      ],
      tall: [
        { x: 0, y: 0, w: 1, h: 0.55, widgets: ['climate'] },
        { x: 0, y: 0.55, w: 1, h: 0.25, widgets: ['doors'] },
        { x: 0, y: 0.8, w: 1, h: 0.2, widgets: ['presence'] },
      ],
    },
  ],
});
