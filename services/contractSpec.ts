/**
 * Contract spec extraction.
 *
 * Every Soroban contract WASM embeds its interface in a custom section named
 * `contractspecv0` — a concatenated stream of XDR-encoded `ScSpecEntry` values.
 * We parse that section at BUILD time (and as a fallback by pulling the on-chain
 * WASM), persist it on the Project/Deployment, and use it to:
 *   - generate the type-aware invoke form on the frontend, and
 *   - encode/decode args + results via `contract.Spec` (never hand-rolled).
 *
 * TESTNET ONLY.
 */
import * as StellarSdk from '@stellar/stellar-sdk';

const xdr: any = (StellarSdk as any).xdr;
const cereal: any = (StellarSdk as any).cereal;
const contractNs: any = (StellarSdk as any).contract;

export interface SpecInput {
  name: string;
  type: string;
}

export interface SpecFunction {
  name: string;
  doc: string;
  inputs: SpecInput[];
  outputs: string[];
}

export interface ParsedSpec {
  /** Base64 XDR `ScSpecEntry` strings — enough to rebuild a `contract.Spec`. */
  entries: string[];
  /** Flattened, human-readable function list for the frontend form builder. */
  functions: SpecFunction[];
}

const TESTNET_RPC = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';

/** Read an unsigned LEB128 integer. Returns [value, bytesConsumed]. */
function readLeb128(buf: Buffer, start: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = start;
  let byte: number;
  do {
    byte = buf[pos++];
    // Use multiplication (not <<) so sizes above 2^31 don't overflow.
    result += (byte & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (byte & 0x80);
  return [result, pos - start];
}

/**
 * Extract the raw `contractspecv0` custom-section bytes from a WASM module, or
 * null if the section is absent.
 */
function extractSpecSection(wasm: Buffer): Buffer | null {
  // Header: magic (\0asm) + version.
  if (wasm.length < 8 || wasm.readUInt32BE(0) !== 0x0061736d) {
    throw new Error('Not a valid WASM module (bad magic bytes)');
  }
  let offset = 8;
  while (offset < wasm.length) {
    const sectionId = wasm[offset];
    offset += 1;
    const [size, sizeBytes] = readLeb128(wasm, offset);
    offset += sizeBytes;
    const payload = wasm.subarray(offset, offset + size);
    offset += size;

    // Section id 0 == custom section: [nameLen][name][content...]
    if (sectionId === 0) {
      const [nameLen, nameLenBytes] = readLeb128(payload, 0);
      const name = payload.subarray(nameLenBytes, nameLenBytes + nameLen).toString('utf8');
      if (name === 'contractspecv0') {
        return Buffer.from(payload.subarray(nameLenBytes + nameLen));
      }
    }
  }
  return null;
}

/** Split the spec section into individual base64 `ScSpecEntry` strings. */
export function extractSpecEntriesFromWasm(wasm: Buffer): string[] {
  const section = extractSpecSection(wasm);
  if (!section || section.length === 0) return [];

  const reader = new cereal.XdrReader(section);
  const entries: string[] = [];
  while (!reader.eof) {
    const entry = xdr.ScSpecEntry.read(reader);
    entries.push(entry.toXDR('base64'));
  }
  return entries;
}

/** Build a `contract.Spec` from persisted base64 entries. */
export function buildSpec(entries: string[]): any {
  const xdrEntries = entries.map((e) => xdr.ScSpecEntry.fromXDR(e, 'base64'));
  return new contractNs.Spec(xdrEntries);
}

/**
 * Render an `ScSpecTypeDef` as a readable type string the frontend maps to an
 * input control: u32/i128/bool/Symbol/String/Address/Bytes/BytesN<n>/
 * Vec<T>/Map<K,V>/Option<T>/Result<T,E>/tuple/<UdtName>.
 */
export function scSpecTypeToString(t: any): string {
  if (!t || typeof t.switch !== 'function') return 'unknown';
  const kind: string = t.switch().name; // e.g. 'scSpecTypeU32'
  const base = kind.replace(/^scSpecType/, '');

  switch (base) {
    case 'Val':
      return 'Val';
    case 'Bool':
      return 'bool';
    case 'Void':
      return 'void';
    case 'Error':
      return 'Error';
    case 'U32':
      return 'u32';
    case 'I32':
      return 'i32';
    case 'U64':
      return 'u64';
    case 'I64':
      return 'i64';
    case 'Timepoint':
      return 'Timepoint';
    case 'Duration':
      return 'Duration';
    case 'U128':
      return 'u128';
    case 'I128':
      return 'i128';
    case 'U256':
      return 'u256';
    case 'I256':
      return 'i256';
    case 'Bytes':
      return 'Bytes';
    case 'String':
      return 'String';
    case 'Symbol':
      return 'Symbol';
    case 'Address':
      return 'Address';
    case 'MuxedAddress':
      return 'MuxedAddress';
    case 'Option':
      try {
        return `Option<${scSpecTypeToString(t.option().valueType())}>`;
      } catch {
        return 'Option';
      }
    case 'Result':
      try {
        return `Result<${scSpecTypeToString(t.result().okType())}, ${scSpecTypeToString(t.result().errorType())}>`;
      } catch {
        return 'Result';
      }
    case 'Vec':
      try {
        return `Vec<${scSpecTypeToString(t.vec().elementType())}>`;
      } catch {
        return 'Vec';
      }
    case 'Map':
      try {
        return `Map<${scSpecTypeToString(t.map().keyType())}, ${scSpecTypeToString(t.map().valueType())}>`;
      } catch {
        return 'Map';
      }
    case 'Tuple':
      try {
        return `(${(t.tuple().valueTypes() as any[]).map(scSpecTypeToString).join(', ')})`;
      } catch {
        return 'Tuple';
      }
    case 'BytesN':
      try {
        return `BytesN<${t.bytesN().n()}>`;
      } catch {
        return 'BytesN';
      }
    case 'Udt':
      try {
        return t.udt().name().toString();
      } catch {
        return 'Udt';
      }
    default:
      return base;
  }
}

/** Parse base64 spec entries into the flattened function list. */
export function parseSpecFunctions(entries: string[]): SpecFunction[] {
  if (!entries.length) return [];
  const spec = buildSpec(entries);
  const funcs: any[] = spec.funcs();
  return funcs.map((fn) => {
    const inputs: SpecInput[] = (fn.inputs() as any[]).map((inp) => ({
      name: inp.name().toString(),
      type: scSpecTypeToString(inp.type()),
    }));
    const outputs: string[] = (fn.outputs() as any[]).map((o) => scSpecTypeToString(o));
    let doc = '';
    try {
      doc = fn.doc().toString();
    } catch {
      doc = '';
    }
    return { name: fn.name().toString(), doc, inputs, outputs };
  });
}

/** Convenience: WASM buffer -> { entries, functions }. */
export function parseSpecFromWasm(wasm: Buffer): ParsedSpec {
  const entries = extractSpecEntriesFromWasm(wasm);
  return { entries, functions: parseSpecFunctions(entries) };
}

/** Same, from a base64 wasm string. */
export function parseSpecFromWasmBase64(wasmBase64: string): ParsedSpec {
  return parseSpecFromWasm(Buffer.from(wasmBase64, 'base64'));
}

/**
 * Fallback: pull the deployed WASM for a contract id from Soroban RPC and parse
 * its spec. Used when a contract was deployed before specs were persisted.
 */
export async function fetchSpecFromChain(contractId: string): Promise<ParsedSpec | null> {
  try {
    const rpc: any = (StellarSdk as any).rpc;
    const server = new rpc.Server(TESTNET_RPC);
    const wasm: Buffer = await server.getContractWasmByContractId(contractId);
    return parseSpecFromWasm(Buffer.from(wasm));
  } catch (err: any) {
    console.warn(`[contractSpec] Could not fetch on-chain spec for ${contractId}: ${err.message}`);
    return null;
  }
}

export default {
  extractSpecEntriesFromWasm,
  buildSpec,
  scSpecTypeToString,
  parseSpecFunctions,
  parseSpecFromWasm,
  parseSpecFromWasmBase64,
  fetchSpecFromChain,
};
