'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { membersApi } from '@/lib/api/client';
import type { InviteMemberRequest, UpdateMemberRoleRequest, AcceptInviteRequest } from '@/lib/api/types';

export const MEMBERS_QUERY_KEY = ['members'] as const;

export function useMemberList() {
  return useQuery({
    queryKey: [...MEMBERS_QUERY_KEY, 'list'],
    queryFn: () => membersApi.list(),
  });
}

export function useInviteMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: InviteMemberRequest) => membersApi.invite(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
    },
  });
}

export function useAcceptInvite() {
  return useMutation({
    mutationFn: (data: AcceptInviteRequest) => membersApi.acceptInvite(data),
  });
}

export function useUpdateMemberRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ memberId, role_code }: { memberId: string } & UpdateMemberRoleRequest) =>
      membersApi.updateRole(memberId, { role_code }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
    },
  });
}

export function useRemoveMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (memberId: string) => membersApi.remove(memberId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
    },
  });
}
