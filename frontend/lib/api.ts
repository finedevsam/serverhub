import axios from 'axios';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

const api = axios.create({ baseURL: API_BASE });

api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('serverhub_token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('serverhub_token');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;

export const auth = {
  login: (username: string, password: string) =>
    api.post('/api/auth/login', { username, password }),
  me: () => api.get('/api/auth/me'),
};

export const servers = {
  list: () => api.get('/api/servers'),
  add: (data: any) => api.post('/api/servers', data),
  delete: (id: string) => api.delete(`/api/servers/${id}`),
  status: (id: string) => api.get(`/api/servers/${id}/status`),
  metrics: (id: string) => api.get(`/api/servers/${id}/metrics`),
  exec: (id: string, command: string) => api.post(`/api/servers/${id}/exec`, { command }),
  services: (id: string) => api.get(`/api/servers/${id}/services`),
  serviceAction: (id: string, service: string, action: string) =>
    api.post(`/api/servers/${id}/services/${service}/action?action=${action}`),
  docker: (id: string) => api.get(`/api/servers/${id}/docker`),
  dockerAction: (id: string, container: string, action: string) =>
    api.post(`/api/servers/${id}/docker/${container}/action?action=${action}`),
  files: (id: string, path: string) => api.get(`/api/servers/${id}/files?path=${encodeURIComponent(path)}`),
  fileContent: (id: string, path: string) => api.get(`/api/servers/${id}/file-content?path=${encodeURIComponent(path)}`),
  upload: (id: string, remotePath: string, file: File) => {
    const form = new FormData();
    form.append('remote_path', remotePath);
    form.append('file', file);
    return api.post(`/api/servers/${id}/upload`, form);
  },
  logs: (id: string, service?: string, lines?: number) =>
    api.get(`/api/servers/${id}/logs?service=${service || 'syslog'}&lines=${lines || 100}`),
};
