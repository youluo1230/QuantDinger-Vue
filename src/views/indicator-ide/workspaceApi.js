import request from '@/utils/request'

/**
 * The workspace archives the user's whole chart through the existing
 * `chart-templates` endpoint: the route and its per-user storage already exist,
 * and the server validates the new `workspace` field next to the legacy
 * `indicators` list.
 */
export const TEMPLATE_ENDPOINT = '/api/users/chart-templates'

export async function listWorkspaceTemplates () {
  const res = await request({ url: TEMPLATE_ENDPOINT, method: 'get' })
  const rows = res && res.data
  return Array.isArray(rows) ? rows : []
}

export async function saveWorkspaceTemplate ({ name, templateId, workspace }) {
  const res = await request({
    url: TEMPLATE_ENDPOINT,
    method: 'post',
    data: {
      name,
      template_id: templateId || '',
      workspace
    }
  })
  return (res && res.data) || null
}

export async function deleteWorkspaceTemplate (templateId) {
  const res = await request({
    url: TEMPLATE_ENDPOINT,
    method: 'delete',
    params: { template_id: templateId }
  })
  return res && res.data
}
