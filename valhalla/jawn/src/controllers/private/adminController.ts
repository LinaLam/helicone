// src/users/usersController.ts
import {
  Body,
  Controller,
  Get,
  Patch,
  Path,
  Post,
  Request,
  Route,
  Security,
  Tags,
} from "tsoa";
import { JawnAuthenticatedRequest } from "../../types/request";
import { supabaseServer } from "../../lib/db/supabase";
import { Setting, SettingName } from "../../utils/settings";
import { clickhouseDb } from "../../lib/db/ClickhouseWrapper";
import { dbExecute } from "../../lib/shared/db/dbExecute";
import { prepareRequestAzure } from "../../lib/experiment/requestPrep/azure";

export const authCheckThrow = async (userId: string | undefined) => {
  if (!userId) {
    throw new Error("Unauthorized");
  }
  const { data, error } = await supabaseServer.client
    .from("admins")
    .select("*");

  if (error) {
    throw new Error(error.message);
  }

  const hasAdmin = data?.map((admin) => admin.user_id).includes(userId);

  if (!hasAdmin) {
    throw new Error("Unauthorized");
  }
};

@Route("v1/admin")
@Tags("Admin")
@Security("api_key")
export class AdminController extends Controller {
  @Post("/orgs/top")
  public async getTopOrgs(
    @Request() request: JawnAuthenticatedRequest,
    @Body()
    body: {
      startDate: string;
      endDate: string;
      tier: "all" | "pro" | "free" | "growth" | "enterprise";
      orgsId?: string[];
      orgsNameContains?: string[];
      emailContains?: string[];
    }
  ) {
    console.log("getTopOrgs");
    await authCheckThrow(request.authParams.userId);
    const orgData = await dbExecute<{
      id: string;
      tier: string;
      owner_email: string;
      owner_last_login: string;
      name: string;
      members: {
        id: string;
        email: string;
        role: string;
        last_active: string;
      }[];
    }>(
      `
    SELECT
      organization.name AS name,
      organization.id AS id,
      organization.tier AS tier,
      users_view.email AS owner_email,
      users_view.last_sign_in_at AS owner_last_login,
      json_agg(
          json_build_object(
              'id', organization_member.member,
              'email', member_user.email,
              'role', organization_member.org_role,
              'last_active', member_user.last_sign_in_at
          )
      ) AS members
    FROM organization
    LEFT JOIN users_view ON organization.owner = users_view.id
    LEFT JOIN organization_member ON organization.id = organization_member.organization
    LEFT JOIN users_view AS member_user ON organization_member.member = member_user.id
    WHERE (
      true 
      ${body.tier !== "all" ? `AND organization.tier = '${body.tier}'` : ""}
    )
    GROUP BY
      organization.id,
      organization.tier,
      users_view.email,
      users_view.last_sign_in_at;
    `,
      []
    );

    if (!orgData.data) {
      return [];
    }

    // Step 1: Fetch top organizations
    const orgs = await clickhouseDb.dbQuery<{
      organization_id: string;
      ct: number;
    }>(
      `
    SELECT
      organization_id,
      count(*) as ct
    FROM request_response_rmt 
    WHERE 
      request_response_rmt.request_created_at > toDateTime('${body.startDate}')
      and request_response_rmt.request_created_at < toDateTime('${
        body.endDate
      }')
    AND organization_id in (
      ${orgData.data
        ?.map((org) => `'${org.id}'`)
        .slice(0, 30)
        .join(",")}
    )
    GROUP BY organization_id
    ORDER BY ct DESC
    `,
      []
    );

    if (!orgs.data) {
      return [];
    }

    if (body.orgsId) {
      orgs.data = orgs.data.filter((org) =>
        body.orgsId?.includes(org.organization_id)
      );
    }
    if (!orgs.data) {
      return [];
    }
    // Step 2: Fetch organization details including members

    orgs.data = orgs.data?.filter((org) =>
      orgData.data?.find((od) => od.id === org.organization_id)
    );

    if (body.orgsNameContains) {
      orgs.data = orgs.data?.filter((org) =>
        body.orgsNameContains?.some((name) =>
          orgData.data
            ?.find((od) => od.id === org.organization_id)
            ?.name.toLowerCase()
            .includes(name.toLowerCase())
        )
      );
    }

    if (body.emailContains) {
      orgs.data = orgs.data?.filter((org) =>
        body.emailContains?.some((email) =>
          orgData.data
            ?.find((od) => od.id === org.organization_id)
            ?.owner_email.toLowerCase()
            .includes(email.toLowerCase())
        )
      );
    }

    let timeGrain = "minute";
    if (
      new Date(body.endDate).getTime() - new Date(body.startDate).getTime() >
      12 * 60 * 60 * 1000
    ) {
      timeGrain = "hour";
    }
    if (
      new Date(body.endDate).getTime() - new Date(body.startDate).getTime() >
      30 * 24 * 60 * 60 * 1000
    ) {
      timeGrain = "day";
    }

    if (!orgs.data || orgs.data.length === 0) {
      return [];
    }
    // Step 3: Fetch organization data over time
    const orgsOverTime = await clickhouseDb.dbQuery<{
      count: number;
      dt: string;
      organization_id: string;
    }>(
      `
      select
        count(*) as count,
        date_trunc('${timeGrain}', request_created_at) AS dt,
        request_response_rmt.organization_id as organization_id
      from request_response_rmt
      where request_response_rmt.organization_id in (
        ${orgs.data
          ?.map((org) => `'${org.organization_id}'`)
          .slice(0, 30)
          .join(",")}
      )
      and request_response_rmt.request_created_at > toDateTime('${
        body.startDate
      }')
      and request_response_rmt.request_created_at < toDateTime('${
        body.endDate
      }')
      group by dt, organization_id
      order by organization_id, dt ASC
      -- WITH FILL FROM toStartOfHour(now() - INTERVAL '30 day') TO toStartOfHour(now()) + 1 STEP INTERVAL 1 HOUR
      WITH FILL FROM toDateTime('${body.startDate}') TO toDateTime('${
        body.endDate
      }') STEP INTERVAL 1 ${timeGrain}
    `,
      []
    );

    // Step 4: Merge all data into one massive object
    const mergedData = orgs.data!.map((org) => {
      const orgDetail = orgData.data!.find(
        (od) => od?.id! === org.organization_id
      );
      const orgOverTime = orgsOverTime.data!.filter(
        (ot) => ot!.organization_id! === org.organization_id
      );

      return {
        ...org,
        ...orgDetail,
        overTime: orgOverTime,
      };
    });

    return mergedData;
  }

  @Get("/admins/query")
  public async getAdmins(@Request() request: JawnAuthenticatedRequest): Promise<
    {
      created_at: string;
      id: number;
      user_email: string | null;
      user_id: string | null;
    }[]
  > {
    const { data, error } = await supabaseServer.client
      .from("admins")
      .select("*");

    return data ?? [];
  }

  @Get("/settings/{name}")
  public async getSetting(
    @Path() name: SettingName,
    @Request() request: JawnAuthenticatedRequest
  ): Promise<Setting> {
    await authCheckThrow(request.authParams.userId);

    const { data, error } = await supabaseServer.client
      .from("helicone_settings")
      .select("*")
      .eq("name", name);

    if (error || data.length === 0) {
      throw new Error(error?.message ?? "No settings found");
    }
    const settings = data[0].settings;

    return JSON.parse(JSON.stringify(settings)) as Setting;
  }

  @Post("/azure/run-test")
  public async azureTest(
    @Request() request: JawnAuthenticatedRequest,
    @Body()
    body: {
      requestBody: any;
    }
  ) {
    await authCheckThrow(request.authParams.userId);

    const azureFetch = await prepareRequestAzure();

    const azureResult = await fetch(azureFetch.url, {
      method: "POST",
      headers: azureFetch.headers,
      body: JSON.stringify(body.requestBody),
    });
    const resultText = await azureResult.text();

    return {
      resultText: resultText,
      fetchParams: {
        url: azureFetch.url,
        headers: azureFetch.headers,
        body: JSON.stringify(body.requestBody),
      },
    };
  }

  @Post("/settings")
  public async updateSetting(
    @Request() request: JawnAuthenticatedRequest,
    @Body()
    body: {
      name: SettingName;
      settings: Setting;
    }
  ): Promise<void> {
    await authCheckThrow(request.authParams.userId);

    const { data: currentSettings } = await supabaseServer.client
      .from("helicone_settings")
      .select("*")
      .eq("name", body.name);

    if (currentSettings!.length === 0) {
      const { error } = await supabaseServer.client
        .from("helicone_settings")
        .insert({
          name: body.name,
          settings: JSON.parse(JSON.stringify(body.settings)),
        });
      if (error) {
        throw new Error(error.message);
      }
    } else {
      const { error } = await supabaseServer.client
        .from("helicone_settings")
        .update({
          settings: JSON.parse(JSON.stringify(body.settings)),
        })
        .eq("name", body.name);
      if (error) {
        throw new Error(error.message);
      }
    }

    return;
  }

  @Post("/orgs/query")
  public async findAllOrgs(
    @Request() request: JawnAuthenticatedRequest,
    @Body()
    body: {
      orgName: string;
    }
  ): Promise<{
    orgs: {
      name: string;
      id: string;
    }[];
  }> {
    await authCheckThrow(request.authParams.userId);

    const { data, error } = await supabaseServer.client
      .from("organization")
      .select("*")
      .ilike("name", `%${body.orgName}%`);
    return {
      orgs:
        data?.map((org) => ({
          name: org.name,
          id: org.id,
        })) ?? [],
    };
  }

  @Post("/orgs/over-time/query")
  public async newOrgsOverTime(
    @Request() request: JawnAuthenticatedRequest,
    @Body()
    body: {
      timeFilter:
        | "1 days"
        | "7 days"
        | "1 month"
        | "3 months"
        | "12 months"
        | "24 months";
      groupBy: "hour" | "day" | "week" | "month";
    }
  ): Promise<{
    newOrgsOvertime: {
      count: string;
      day: string;
    }[];
    newUsersOvertime: {
      count: string;
      day: string;
    }[];
    usersOverTime: {
      count: string;
      day: string;
    }[];
  }> {
    await authCheckThrow(request.authParams.userId);

    const orgData = await dbExecute<{
      count: string;
      day: string;
    }>(
      `
      SELECT
        count(*) as count,
        date_trunc('${body.groupBy}', created_at) AS day
      FROM organization
      WHERE 
        created_at > now() - INTERVAL '${body.timeFilter}'
      GROUP BY day
      ORDER BY day ASC

    `,
      []
    );

    const userData = await dbExecute<{
      count: string;
      day: string;
    }>(
      `
      SELECT
        count(*) as count,
        date_trunc('${body.groupBy}', created_at) AS day
      FROM auth.users
      WHERE 
        created_at > now() - INTERVAL '${body.timeFilter}'
      GROUP BY day
      ORDER BY day ASC
    `,
      []
    );

    const countBeforeTimeFilter = await dbExecute<{
      count: string;
    }>(
      `
      SELECT count(*) as count FROM auth.users
      WHERE created_at < now() - INTERVAL '${body.timeFilter}'
      `,
      []
    );

    const userOverTime = await dbExecute<{
      count: string;
      day: string;
    }>(
      `
      WITH user_counts AS (
        SELECT
          date_trunc('${body.groupBy}', created_at) AS day,
          count(*) as new_users
        FROM auth.users
        WHERE created_at > now() - INTERVAL '${body.timeFilter}'
        GROUP BY day
      )
      SELECT
        day,
        sum(new_users) OVER (ORDER BY day) as count
      FROM user_counts
      ORDER BY day ASC
    `,
      []
    );

    return {
      newOrgsOvertime: orgData.data ?? [],
      newUsersOvertime: userData.data ?? [],
      usersOverTime:
        userOverTime.data?.map((data) => ({
          count: (
            +data.count + +countBeforeTimeFilter.data![0].count
          ).toString(),
          day: data.day,
        })) ?? [],
    };
  }

  @Post("/admins/org/query")
  public async addAdminsToOrg(
    @Request() request: JawnAuthenticatedRequest,
    @Body()
    body: {
      orgId: string;
      adminIds: string[];
    }
  ): Promise<void> {
    await authCheckThrow(request.authParams.userId);
    const { orgId, adminIds } = body;

    const { data, error } = await supabaseServer.client
      .from("organization_member")
      .insert(
        adminIds.map((adminId) => ({
          organization: orgId,
          member: adminId,
          org_role: "admin",
        }))
      );

    if (error) {
      throw new Error(error.message);
    }

    return;
  }

  @Post("/alert_banners")
  public async createAlertBanner(
    @Request() request: JawnAuthenticatedRequest,
    @Body()
    body: {
      title: string;
      message: string;
    }
  ): Promise<void> {
    await authCheckThrow(request.authParams.userId);

    const { data, error } = await supabaseServer.client
      .from("alert_banners")
      .insert({
        title: body.title,
        message: body.message,
        active: false,
      });

    if (error) {
      throw new Error(error.message);
    }
  }

  @Patch("/alert_banners")
  public async updateAlertBanner(
    @Request() request: JawnAuthenticatedRequest,
    @Body()
    body: {
      id: number;
      active: boolean;
    }
  ): Promise<void> {
    await authCheckThrow(request.authParams.userId);

    const { data, error } = await supabaseServer.client
      .from("alert_banners")
      .select("*")
      .order("created_at", { ascending: false });

    if (body.active) {
      const activeBanner = data?.find((banner) => banner.active);
      if (activeBanner) {
        throw new Error(
          "There is already an active banner. Please deactivate it first"
        );
      }
    }

    const { data: updateData, error: updateError } = await supabaseServer.client
      .from("alert_banners")
      .update({
        active: body.active,
        updated_at: new Date().toISOString(),
      })
      .match({ id: body.id });

    if (updateError) {
      throw new Error(updateError.message);
    }
  }
}
