/**
 * Response serialization helpers.
 *
 * The frontend was written against Mongoose documents and expects an `_id`
 * field. Prisma uses `id`, so we expose `_id` alongside `id` to keep the API
 * contract stable.
 */

/** Add an `_id` alias (= id) to a plain object. Returns null/undefined as-is. */
export function withId(obj: any): any {
  if (!obj) return obj;
  return { ...obj, _id: obj.id };
}

/** Map an array through withId. */
export function withIds(arr: any): any {
  return Array.isArray(arr) ? arr.map(withId) : arr;
}

/**
 * Serialize a Prisma Project (optionally with `files` and `deployments`
 * relations) into the shape the frontend expects, including `_id`, a `files`
 * array, and a `deploymentHistory` array derived from Deployment rows.
 */
export function serializeProject(project: any): any {
  if (!project) return project;
  const files = Array.isArray(project.files)
    ? project.files.map((f: any) => ({
        _id: f.id,
        id: f.id,
        name: f.name,
        type: f.type,
        content: f.content
      }))
    : [];

  const deploymentHistory = Array.isArray(project.deployments)
    ? project.deployments.map((d: any) => ({
        _id: d.id,
        timestamp: d.createdAt,
        contractAddress: d.contractAddress,
        status: d.status,
        logs: d.logs || []
      }))
    : undefined;

  const out: Record<string, any> = {
    _id: project.id,
    id: project.id,
    name: project.name,
    userId: project.userId,
    files,
    contractAddress: project.contractAddress,
    lastDeployed: project.lastDeployed,
    isLocal: project.isLocal,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  };
  if (deploymentHistory !== undefined) out.deploymentHistory = deploymentHistory;
  return out;
}

export default { withId, withIds, serializeProject };
