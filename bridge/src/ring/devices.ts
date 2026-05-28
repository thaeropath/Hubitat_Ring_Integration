export type RingDeviceKind = 'camera' | 'doorbell' | 'contact-sensor' | 'alarm' | 'lock';

export interface DeviceInfo {
  id: string;
  name: string;
  type: RingDeviceKind;
  locationId: string;
}

export interface HubitatEvent {
  deviceId: string;
  type: 'motion' | 'ding' | 'contact' | 'alarm' | 'lock';
  value: string;
  lastUser?: string;
}
