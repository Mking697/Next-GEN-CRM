import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";

export default async function RootPage() {
  const user = await currentUser();
  redirect(user ? "/overview" : "/login");
}
