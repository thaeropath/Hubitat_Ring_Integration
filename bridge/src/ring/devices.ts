export type RingDeviceKind = 'camera' | 'doorbell' | 'contact-sensor' | 'alarm' | 'lock' | 'light';

export interface DeviceInfo {
  id: string;
  name: string;
  type: RingDeviceKind;
  locationId: string;
}

export interface HubitatEvent {
  deviceId: string;
  type: 'motion' | 'ding' | 'contact' | 'alarm' | 'lock' | 'switch' | 'level';
  value: string;
  lastUser?: string;
}
