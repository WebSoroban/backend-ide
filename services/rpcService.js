/**
 * Soroban RPC proxy service.
 * Forwards JSON-RPC requests to the configured Soroban RPC node.
 */

const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';

/**
 * Forward a JSON-RPC request to the Soroban RPC node.
 * @param {Object} body - JSON-RPC request body (method, params, id, jsonrpc)
 * @param {Object} options - Optional { logRequest }
 * @returns {Promise<Object>} JSON-RPC response
 */
async function forwardRequest(body, options = {}) {
  const { logRequest = false } = options;

  if (logRequest) {
    console.log('[RpcService] Forwarding request:', {
      method: body.method,
      id: body.id,
      paramsLength: body.params ? (Array.isArray(body.params) ? body.params.length : Object.keys(body.params || {}).length) : 0
    });
  }

  const response = await fetch(SOROBAN_RPC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    console.error('[RpcService] Upstream error:', response.status, text);
    throw new Error(`RPC upstream error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (logRequest && data.result !== undefined) {
    console.log('[RpcService] Success:', body.method, 'id:', body.id);
  }
  return data;
}

/**
 * Batch forward multiple JSON-RPC requests.
 * @param {Array<Object>} requests - Array of JSON-RPC request objects
 * @param {Object} options - Optional { logRequest }
 * @returns {Promise<Array<Object>>} Array of JSON-RPC responses
 */
async function forwardBatch(requests, options = {}) {
  if (!Array.isArray(requests) || requests.length === 0) {
    return [];
  }
  const response = await fetch(SOROBAN_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requests)
  });
  if (!response.ok) {
    const text = await response.text();
    console.error('[RpcService] Batch upstream error:', response.status, text);
    throw new Error(`RPC upstream error: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  return Array.isArray(data) ? data : [data];
}

module.exports = {
  forwardRequest,
  forwardBatch,
  SOROBAN_RPC_URL
};
