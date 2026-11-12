import { eq } from "drizzle-orm";
import { db, organizationsTable, vehiclesTable, customersTable, stopsTable, routesTable, driversTable, usersTable } from "@workspace/db";

const FIXED_ORG_ID = "63e7175d-af1d-4dc3-be62-842a8b3dc9f8";

export async function autoSeed() {
  if (process.env.NODE_ENV !== "development" || process.env.ALLOW_DEV_SEED !== "true") {
    return;
  }

  const existingOrgs = await db.select().from(organizationsTable).limit(1);
  if (existingOrgs.length > 0) {
    console.log("Database already seeded, skipping auto-seed");
    return;
  }

  console.log("Auto-seeding database...");

  const [org] = await db
    .insert(organizationsTable)
    .values({
      id: FIXED_ORG_ID,
      name: "Stockholm Logistics AB",
      email: "info@stockholm-logistics.se",
    })
    .returning();

  console.log(`Created organization: ${org.name} (${org.id})`);

  const vehicleData = [
    {
      organizationId: org.id,
      name: "Volvo FH16",
      licensePlate: "ABC 123",
      vehicleType: "fossil" as const,
      capacityKg: 2000,
      capacityVolume: 20,
    },
    {
      organizationId: org.id,
      name: "Scania R500",
      licensePlate: "DEF 456",
      vehicleType: "fossil" as const,
      capacityKg: 2500,
      capacityVolume: 25,
    },
    {
      organizationId: org.id,
      name: "Tesla Semi",
      licensePlate: "EV 001",
      vehicleType: "electric" as const,
      capacityKg: 1800,
      capacityVolume: 18,
      batteryCapacityKwh: 500,
      currentBatteryPercent: 85,
      rangeKm: 480,
    },
    {
      organizationId: org.id,
      name: "Volvo FE Electric",
      licensePlate: "EV 002",
      vehicleType: "electric" as const,
      capacityKg: 1200,
      capacityVolume: 14,
      batteryCapacityKwh: 264,
      currentBatteryPercent: 92,
      rangeKm: 200,
    },
  ];

  const vehicles = await db.insert(vehiclesTable).values(vehicleData).returning();
  console.log(`Created ${vehicles.length} vehicles`);

  const driverData = [
    { organizationId: org.id, name: "Tomas Björnberg", phone: "0704407450", email: "tomas@nordicrouting.se", vehicleId: vehicles[0].id, isActive: true },
    { organizationId: org.id, name: "Erik Johansson", phone: "+46701234567", email: "erik@test.com", vehicleId: null, isActive: true },
    { organizationId: org.id, name: "Anna Lindström", phone: "+46709876543", email: "anna@test.com", vehicleId: vehicles[2].id, isActive: true },
  ];

  const drivers = await db.insert(driversTable).values(driverData).returning();
  console.log(`Created ${drivers.length} drivers`);

  const customerData = [
    { organizationId: org.id, name: "IKEA Kungens Kurva", address: "Modulvägen 1, Kungens Kurva" },
    { organizationId: org.id, name: "Ericsson HQ", address: "Torshamnsgatan 23, Kista" },
    { organizationId: org.id, name: "Karolinska Sjukhuset", address: "Eugeniavägen 3, Solna" },
    { organizationId: org.id, name: "Stockholms Universitet", address: "Universitetsvägen 10, Stockholm" },
    { organizationId: org.id, name: "Globen Arena", address: "Globentorget 2, Stockholm" },
    { organizationId: org.id, name: "NK Varuhus", address: "Hamngatan 18-20, Stockholm" },
    { organizationId: org.id, name: "Tekniska Museet", address: "Museivägen 7, Stockholm" },
    { organizationId: org.id, name: "Skansen", address: "Djurgårdsslätten 49-51, Stockholm" },
    { organizationId: org.id, name: "Södra Station", address: "Rosenlundsgatan 44, Stockholm" },
    { organizationId: org.id, name: "Fridhemsplan Kontor", address: "Fridhemsgatan 20, Stockholm" },
    { organizationId: org.id, name: "Hammarby Sjöstad", address: "Hammarby Allé 45, Stockholm" },
    { organizationId: org.id, name: "Nacka Forum", address: "Forumvägen 12, Nacka" },
  ];

  const customers = await db.insert(customersTable).values(customerData).returning();
  console.log(`Created ${customers.length} customers`);

  const today = new Date();
  today.setHours(8, 0, 0, 0);

  const stopData = [
    { organizationId: org.id, customerId: customers[0].id, address: "Modulvägen 1, Kungens Kurva", latitude: 59.2753, longitude: 17.9283, timeWindowStart: new Date(today.getTime()), timeWindowEnd: new Date(today.getTime() + 2 * 3600000), serviceDurationMin: 20, weightKg: 150, volumeM3: 2.5 },
    { organizationId: org.id, customerId: customers[1].id, address: "Torshamnsgatan 23, Kista", latitude: 59.4047, longitude: 17.9498, timeWindowStart: new Date(today.getTime() + 1 * 3600000), timeWindowEnd: new Date(today.getTime() + 3 * 3600000), serviceDurationMin: 15, weightKg: 50, volumeM3: 0.5 },
    { organizationId: org.id, customerId: customers[2].id, address: "Eugeniavägen 3, Solna", latitude: 59.3525, longitude: 18.0347, timeWindowStart: new Date(today.getTime() + 2 * 3600000), timeWindowEnd: new Date(today.getTime() + 4 * 3600000), serviceDurationMin: 10, weightKg: 30, volumeM3: 0.3 },
    { organizationId: org.id, customerId: customers[3].id, address: "Universitetsvägen 10, Stockholm", latitude: 59.3656, longitude: 18.0587, serviceDurationMin: 15, weightKg: 80, volumeM3: 1.0 },
    { organizationId: org.id, customerId: customers[4].id, address: "Globentorget 2, Stockholm", latitude: 59.2936, longitude: 18.0832, timeWindowStart: new Date(today.getTime()), timeWindowEnd: new Date(today.getTime() + 2 * 3600000), serviceDurationMin: 25, weightKg: 200, volumeM3: 3.0 },
    { organizationId: org.id, customerId: customers[5].id, address: "Hamngatan 18-20, Stockholm", latitude: 59.3334, longitude: 18.0712, timeWindowStart: new Date(today.getTime() + 3 * 3600000), timeWindowEnd: new Date(today.getTime() + 5 * 3600000), serviceDurationMin: 10, weightKg: 25, volumeM3: 0.4 },
    { organizationId: org.id, customerId: customers[6].id, address: "Museivägen 7, Stockholm", latitude: 59.3269, longitude: 18.0916, serviceDurationMin: 15, weightKg: 40, volumeM3: 0.6 },
    { organizationId: org.id, customerId: customers[7].id, address: "Djurgårdsslätten 49-51, Stockholm", latitude: 59.3261, longitude: 18.1036, timeWindowStart: new Date(today.getTime() + 1 * 3600000), timeWindowEnd: new Date(today.getTime() + 3 * 3600000), serviceDurationMin: 20, weightKg: 100, volumeM3: 1.5 },
    { organizationId: org.id, customerId: customers[8].id, address: "Rosenlundsgatan 44, Stockholm", latitude: 59.3149, longitude: 18.0627, serviceDurationMin: 10, weightKg: 35, volumeM3: 0.4 },
    { organizationId: org.id, customerId: customers[9].id, address: "Fridhemsgatan 20, Stockholm", latitude: 59.3323, longitude: 18.0283, timeWindowStart: new Date(today.getTime() + 2 * 3600000), timeWindowEnd: new Date(today.getTime() + 4 * 3600000), serviceDurationMin: 15, weightKg: 60, volumeM3: 0.8 },
    { organizationId: org.id, customerId: customers[10].id, address: "Hammarby Allé 45, Stockholm", latitude: 59.3041, longitude: 18.1017, serviceDurationMin: 20, weightKg: 120, volumeM3: 1.8 },
    { organizationId: org.id, customerId: customers[11].id, address: "Forumvägen 12, Nacka", latitude: 59.3100, longitude: 18.1639, timeWindowStart: new Date(today.getTime() + 1 * 3600000), timeWindowEnd: new Date(today.getTime() + 4 * 3600000), serviceDurationMin: 15, weightKg: 70, volumeM3: 1.0 },
  ];

  const stops = await db.insert(stopsTable).values(stopData).returning();
  console.log(`Created ${stops.length} stops`);

  const [route1] = await db.insert(routesTable).values({
    organizationId: org.id,
    vehicleId: vehicles[0].id,
    name: "Northern Stockholm Route",
    date: today,
    status: "optimized",
    totalStops: 4,
    totalDistanceKm: 28.5,
    totalDurationMin: 95,
    co2EmissionsKg: 5.99,
  }).returning();

  const [route2] = await db.insert(routesTable).values({
    organizationId: org.id,
    vehicleId: vehicles[2].id,
    name: "Central Stockholm EV Route",
    date: today,
    status: "optimized",
    totalStops: 4,
    totalDistanceKm: 12.3,
    totalDurationMin: 65,
    co2EmissionsKg: 0.25,
  }).returning();

  for (let i = 0; i < 4; i++) {
    await db.update(stopsTable)
      .set({ routeId: route1.id, sequenceOrder: i + 1, status: "pending", terminalAt: null })
      .where(eq(stopsTable.id, stops[i].id));
  }

  for (let i = 4; i < 8; i++) {
    await db.update(stopsTable)
      .set({ routeId: route2.id, sequenceOrder: i - 3, status: "pending", terminalAt: null })
      .where(eq(stopsTable.id, stops[i].id));
  }

  const userData = [
    { id: "a1000000-0000-0000-0000-000000000001", organizationId: org.id, name: "Admin User", email: "admin@stockholm-logistics.se", role: "admin" as const },
    { id: "a1000000-0000-0000-0000-000000000002", organizationId: org.id, name: "Dispatch User", email: "dispatch@stockholm-logistics.se", role: "dispatcher" as const },
    { id: "a1000000-0000-0000-0000-000000000003", organizationId: org.id, name: "Tomas Björnberg", email: "tomas@stockholm-logistics.se", role: "driver" as const, driverProfileId: drivers[0].id },
  ];

  const users = await db.insert(usersTable).values(userData).returning();
  console.log(`Created ${users.length} users`);

  console.log("Auto-seed complete!");
}
