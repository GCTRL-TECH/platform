import {
  useQuery,
  useMutation,
  type UseQueryOptions,
  type UseMutationOptions,
  type QueryKey,
} from '@tanstack/react-query'
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api'
import type { AxiosRequestConfig } from 'axios'

type HttpMethod = 'POST' | 'PUT' | 'DELETE' | 'PATCH'

// Generic GET hook
export function useApiQuery<TData = unknown>(
  key: QueryKey,
  url: string,
  options?: Omit<UseQueryOptions<TData, Error>, 'queryKey' | 'queryFn'> & {
    axiosConfig?: AxiosRequestConfig
  }
) {
  const { axiosConfig, ...queryOptions } = options ?? {}

  return useQuery<TData, Error>({
    queryKey: key,
    queryFn: () => apiGet<TData>(url, axiosConfig),
    ...queryOptions,
  })
}

interface MutationVariables<TBody = unknown> {
  data?: TBody
  urlParams?: Record<string, string>
  config?: AxiosRequestConfig
}

// Generic mutation hook
export function useApiMutation<TData = unknown, TBody = unknown>(
  url: string,
  method: HttpMethod = 'POST',
  options?: UseMutationOptions<TData, Error, MutationVariables<TBody>>
) {
  return useMutation<TData, Error, MutationVariables<TBody>>({
    mutationFn: async ({ data, config } = {}) => {
      switch (method) {
        case 'POST':
          return apiPost<TData>(url, data, config)
        case 'PUT':
          return apiPut<TData>(url, data, config)
        case 'DELETE':
          return apiDelete<TData>(url, config)
        default:
          return apiPost<TData>(url, data, config)
      }
    },
    ...options,
  })
}

// Convenience: upload mutation (multipart/form-data)
export function useUploadMutation<TData = unknown>(
  url: string,
  options?: UseMutationOptions<TData, Error, FormData>
) {
  return useMutation<TData, Error, FormData>({
    mutationFn: async (formData: FormData) =>
      apiPost<TData>(url, formData, {
        headers: { 'Content-Type': undefined },
      }),
    ...options,
  })
}
