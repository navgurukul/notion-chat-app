import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { hasNavgurukulDomainAccess } from "@/lib/shared/navgurukul-domain";

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async signIn({ user }) {
      // Block unknown users immediately during Google sign-in.
      // Only users with @navgurukul.org email are allowed.
      return hasNavgurukulDomainAccess({
        user: { email: user?.email ?? undefined },
      });
    },
  },
};

