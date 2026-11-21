import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const demoUsers = [
  { id: "anika", name: "Anika", role: "CENTRE", district: "North" },
  { id: "dev", name: "Dev", role: "DISTRICT_OFFICER", district: "North" },
  { id: "meera", name: "Meera", role: "DISTRICT_OFFICER", district: "North" },
  { id: "kabir", name: "Kabir", role: "DISTRICT_OFFICER", district: "North" },
  { id: "neha", name: "Neha", role: "QUALITY_TEAM", district: null },
  { id: "farah", name: "Farah", role: "STATE_OFFICE", district: null },
] as const;

async function main() {
  for (const user of demoUsers) {
    await prisma.user.upsert({
      where: { id: user.id },
      update: {
        name: user.name,
        role: user.role,
        district: user.district,
      },
      create: user,
    });
  }
}

main()
  .catch((error: unknown) => {
    console.error("Failed to seed demo users:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
