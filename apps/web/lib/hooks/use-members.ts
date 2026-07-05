'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { membersApi } from '@/lib/api/client';
import type { InviteMemberRequest, UpdateMemberRoleRequest, AcceptInviteRequest } from '@/lib/api/types';

const MEMBERS_QUERY_KEY = ['members'] as const;
const PENDING_INVITES_QUERY_KEY = ['members', 'pending-invites'] as const;

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

// ── Pending-invite hooks (D-4/D-11) ───────────────────────────────────────────

export function usePendingInvites() {
  return useQuery({
    queryKey: PENDING_INVITES_QUERY_KEY,
    queryFn: () => membersApi.listPendingInvites(),
  });
}

export function useResendInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => membersApi.resendInvite(inviteId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PENDING_INVITES_QUERY_KEY });
    },
  });
}

export function useRevokeInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => membersApi.revokeInvite(inviteId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PENDING_INVITES_QUERY_KEY });
    },
  });
}

// ── Suspend / reactivate hooks (D-8/D-1) ─────────────────────────────────────

export function useSuspendMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (memberId: string) => membersApi.suspendMember(memberId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
    },
  });
}

export function useReactivateMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (memberId: string) => membersApi.reactivateMember(memberId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
    },
  });
}
