import type { BusinessRecord } from "../db/businesses";
import type { RouteDeps } from "../webhook/router";

/** Resolve the user's business, or null (flow defaults apply when unknown). */
export async function resolveBusiness(
  deps: RouteDeps,
  phoneNumber: string,
): Promise<BusinessRecord | null> {
  const user = await deps.users.findUser(phoneNumber);
  if (!user?.businessId) return null;
  return deps.businesses.findBusiness(user.businessId);
}
