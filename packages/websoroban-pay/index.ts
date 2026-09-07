import type { RequestHandler } from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';

const { HTTPFacilitatorClient } = require('@x402/core/server') as {
  HTTPFacilitatorClient: new (config: Record<string, unknown>) => any;
};
const { ExactStellarScheme } = require('@x402/stellar/exact/server') as {
  ExactStellarScheme: new () => any;
};

const STELLAR_TESTNET = 'stellar:testnet' as const;

export interface WebSorobanPayOptions {
  /** WebSoroban API root, for example https://api.example.com/api. */
  apiUrl: string;
  /** Scoped endpoint key returned once by the WebSoroban Pay studio. */
  apiKey: string | undefined;
  /** Endpoint id shown in the studio. Reserved for telemetry correlation. */
  endpointId: string;
  /** Stellar testnet G-address that receives USDC. */
  payTo: string;
}

export interface ProtectOptions {
  description?: string;
  maxTimeoutSeconds?: number;
}

/**
 * Creates x402 Express middleware backed by WebSoroban's managed facilitator.
 * The endpoint key is sent only to the WebSoroban server, never to a browser.
 */
export function createWebSorobanPay(options: WebSorobanPayOptions) {
  if (!options.apiKey) throw new Error('WEBSOROBAN_PAY_KEY is required.');
  if (!options.apiUrl) throw new Error('A WebSoroban API URL is required.');
  if (!options.endpointId) throw new Error('A WebSoroban endpoint id is required.');

  const url = `${options.apiUrl.replace(/\/$/, '')}/pay/facilitator`;
  const auth = { Authorization: `Bearer ${options.apiKey}` };
  const facilitator = new HTTPFacilitatorClient({
    url,
    createAuthHeaders: async () => ({ verify: auth, settle: auth, supported: auth }),
  });
  const server = new x402ResourceServer(facilitator)
    .register(STELLAR_TESTNET, new ExactStellarScheme());

  return {
    protect(route: `${'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'} /${string}`, price: string, config: ProtectOptions = {}): RequestHandler {
      return paymentMiddleware({
        [route]: {
          accepts: {
            scheme: 'exact',
            network: STELLAR_TESTNET,
            price,
            payTo: options.payTo,
            maxTimeoutSeconds: config.maxTimeoutSeconds ?? 60,
          },
          serviceName: 'WebSoroban Pay',
          description: config.description || 'A Stellar testnet endpoint protected by x402.',
          mimeType: 'application/json',
        },
      }, server, undefined, undefined, true);
    },
  };
}
