import { useQueryClient } from "@tanstack/react-query";
import {
  useListCustomers,
  useCreateCustomer,
  useUpdateCustomer,
  useArchiveCustomer,
  useCreateCustomerSite,
  useUpdateCustomerSite,
  useArchiveCustomerSite,
  usePlanCustomerVisits,
  getListCustomersQueryKey,
  type Customer,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";

export function useCustomers(includeArchived = false) {
  const { user } = useAuth();
  return useListCustomers(
    { includeArchived },
    {
      query: {
        enabled: !!user,
        queryKey: getListCustomersQueryKey({ includeArchived }),
      },
    }
  );
}

export function useCustomerMutations() {
  const queryClient = useQueryClient();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });

  const syncCustomer = (customer: Customer) => {
    // Apply the authoritative site list before the caller selects a newly
    // created site. Otherwise selection reconciliation sees the old list.
    queryClient.setQueriesData<Customer[]>(
      { queryKey: getListCustomersQueryKey() },
      (previous) => previous?.map((entry) => entry.id === customer.id ? customer : entry),
    );
    return invalidate();
  };

  const createCustomer = useCreateCustomer({
    mutation: { onSuccess: invalidate },
  });

  const updateCustomer = useUpdateCustomer({
    mutation: { onSuccess: syncCustomer },
  });

  const archiveCustomer = useArchiveCustomer({
    mutation: { onSuccess: invalidate },
  });

  const createSite = useCreateCustomerSite({
    mutation: { onSuccess: syncCustomer },
  });

  const updateSite = useUpdateCustomerSite({
    mutation: { onSuccess: syncCustomer },
  });

  const archiveSite = useArchiveCustomerSite({
    mutation: { onSuccess: invalidate },
  });

  const planVisits = usePlanCustomerVisits({
    mutation: { onSuccess: invalidate },
  });

  return {
    createCustomer,
    updateCustomer,
    archiveCustomer,
    createSite,
    updateSite,
    archiveSite,
    planVisits,
  };
}
