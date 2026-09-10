import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { isAdmin } from "@/lib/auth/admin";
import CostReportPage from "./CostReportPage";

export default async function Page() {
  const session = await getServerSession(authOptions);

  if (!isAdmin(session?.user?.email)) {
    redirect("/"); 
  }

  return <CostReportPage />;
}