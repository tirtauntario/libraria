import { connect, disconnect } from '@codedread/bitjs/archive/unrar.js';

self.onmessage = (evt: MessageEvent) => {
  if (evt.ports.length > 0) {
    connect(evt.ports[0]!);
  } else if (evt.data?.disconnect) {
    disconnect();
  }
};
