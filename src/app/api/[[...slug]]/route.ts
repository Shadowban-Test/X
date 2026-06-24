import { logger } from "hono/logger";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import {
  ResultsSchema,
  TestQuerySchema,
  XClientTransactionIdQuerySchema,
  XClientTransactionIdResponseSchema,
} from "./schemas";
import ky from "ky";
import { ClientTransaction, fetchXDocument } from "x-client-transaction-id";

function generateRandomHexString(length: number) {
  let result = "";
  const characters = "0123456789abcdef";
  for (let i = 0; i < length * 2; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

export const runtime = "edge";

const app = new OpenAPIHono().basePath("/api");

app.use(logger());

app.doc("/openapi.json", {
  openapi: "3.0.0",
  info: {
    version: "1.0.0",
    title: "X (Twitter) Shadowban Test API",
  },
  servers: [
    {
      url: "/api",
    },
  ],
});

app.get(
  "/docs",
  swaggerUI({
    url: "/api/openapi.json",
  })
);

app.openapi(
  createRoute({
    method: "get",
    path: "/x-client-transaction-id",
    request: {
      query: XClientTransactionIdQuerySchema,
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: XClientTransactionIdResponseSchema,
          },
        },
        description: "成功",
      },
    },
  }),
  async (c) => {
    const { method, path } = c.req.valid("query");
    const response = await fetchXDocument();
    const ct = await ClientTransaction.create(response);
    const xClientTransactionId = await ct.generateTransactionId(method, path);
    return c.json(
      {
        "x-client-transaction-id": xClientTransactionId,
      },
      200
    );
  }
);

const route = app.openapi(
  createRoute({
    method: "get",
    path: "/test",
    request: {
      query: TestQuerySchema,
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: ResultsSchema,
          },
        },
        description: "成功",
      },
    },
  }),
  async (c) => {
    const authToken = process.env.AUTH_TOKEN;
    if (!authToken) {
      throw new Error("AUTH_TOKEN is not defined");
    }
    const csrfToken = generateRandomHexString(16);
    const response = await fetchXDocument();
    const ct = await ClientTransaction.create(response);
    const client = ky.create({
      prefixUrl: "https://api.twitter.com",
      headers: {
        authorization:
          "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
        "sec-ch-ua":
          '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "sec-gpc": "1",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
        "x-csrf-token": csrfToken,
        "x-twitter-active-user": "yes",
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-client-language": "ja",
        cookie: `auth_token=${authToken}; ct0=${csrfToken}`,
      },
      hooks: {
        beforeRequest: [
          async (request) => {
            const xClientTransactionId = await ct.generateTransactionId(
              request.method,
              new URL(request.url).pathname
            );
            request.headers.set(
              "x-client-transaction-id",
              xClientTransactionId
            );
          },
        ],
      },
    });
    const { screen_name: screenName } = c.req.valid("query");
    const {
      data: { user },
    } = await client
      .get("graphql/k5XapwcSikNsEsILW5FvgA/UserByScreenName", {
        searchParams: {
          variables: JSON.stringify({
            screen_name: screenName,
            withSafetyModeUserFields: true,
          }),
          features: JSON.stringify({
            hidden_profile_likes_enabled: true,
            hidden_profile_subscriptions_enabled: true,
            responsive_web_graphql_exclude_directive_enabled: true,
            verified_phone_label_enabled: false,
            subscriptions_verification_info_is_identity_verified_enabled: true,
            subscriptions_verification_info_verified_since_enabled: true,
            highlights_tweets_tab_ui_enabled: true,
            responsive_web_twitter_article_notes_tab_enabled: true,
            creator_subscriptions_tweet_preview_api_enabled: true,
            responsive_web_graphql_skip_user_profile_image_extensions_enabled:
              false,
            responsive_web_graphql_timeline_navigation_enabled: true,
          }),
          fieldToggles: JSON.stringify({
            withAuxiliaryUserLabels: false,
          }),
        },
      })
      .json<any>();
    if (!user) {
      return c.json({
        not_found: true,
        suspend: false,
        protect: false,
        no_tweet: false,
        search_ban: false,
        search_suggestion_ban: false,
        no_reply: false,
        ghost_ban: false,
        reply_deboosting: false,
        user: null,
      });
    }
    if (user.result.__typename !== "User") {
      return c.json({
        not_found: false,
        suspend: true,
        protect: false,
        no_tweet: false,
        search_ban: false,
        search_suggestion_ban: false,
        no_reply: false,
        ghost_ban: false,
        reply_deboosting: false,
        user: user.result,
      });
    }
    if (user.result.legacy.protected) {
      return c.json({
        not_found: false,
        suspend: false,
        protect: true,
        no_tweet: false,
        search_ban: false,
        search_suggestion_ban: false,
        no_reply: false,
        ghost_ban: false,
        reply_deboosting: false,
        user: user.result,
      });
    }
    if (!user.result.legacy.statuses_count) {
      return c.json({
        not_found: false,
        suspend: false,
        protect: false,
        no_tweet: true,
        search_ban: false,
        search_suggestion_ban: false,
        no_reply: false,
        ghost_ban: false,
        reply_deboosting: false,
        user: user.result,
      });
    }
    const {
      data: {
        search_by_raw_query: { search_timeline: searchTimeline },
      },
    } = await client
      .get("graphql/AIdc203rPpK_k_2KWSdm7g/SearchTimeline", {
        searchParams: {
          variables: JSON.stringify({
            rawQuery: `from:${user.result.legacy.screen_name}`,
            count: 20,
            querySource: "typed_query",
            product: "Top",
          }),
          features: JSON.stringify({
            rweb_video_screen_enabled: false,
            profile_label_improvements_pcf_label_in_post_enabled: true,
            rweb_tipjar_consumption_enabled: true,
            verified_phone_label_enabled: false,
            creator_subscriptions_tweet_preview_api_enabled: true,
            responsive_web_graphql_timeline_navigation_enabled: true,
            responsive_web_graphql_skip_user_profile_image_extensions_enabled:
              false,
            premium_content_api_read_enabled: false,
            communities_web_enable_tweet_community_results_fetch: true,
            c9s_tweet_anatomy_moderator_badge_enabled: true,
            responsive_web_grok_analyze_button_fetch_trends_enabled: false,
            responsive_web_grok_analyze_post_followups_enabled: true,
            responsive_web_jetfuel_frame: false,
            responsive_web_grok_share_attachment_enabled: true,
            articles_preview_enabled: true,
            responsive_web_edit_tweet_api_enabled: true,
            graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
            view_counts_everywhere_api_enabled: true,
            longform_notetweets_consumption_enabled: true,
            responsive_web_twitter_article_tweet_consumption_enabled: true,
            tweet_awards_web_tipping_enabled: false,
            responsive_web_grok_show_grok_translated_post: false,
            responsive_web_grok_analysis_button_from_backend: false,
            creator_subscriptions_quote_tweet_preview_enabled: false,
            freedom_of_speech_not_reach_fetch_enabled: true,
            standardized_nudges_misinfo: true,
            tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled:
              true,
            longform_notetweets_rich_text_read_enabled: true,
            longform_notetweets_inline_media_enabled: true,
            responsive_web_grok_image_annotation_enabled: true,
            responsive_web_enhance_cards_enabled: false,
          }),
        },
      })
      .json<any>();
    let searchBanFlag = true;
    for (const instruction of searchTimeline.timeline.instructions) {
      for (const entry of instruction.entries) {
        if (entry.entryId.startsWith("tweet-")) {
          if (
            entry.content.itemContent.tweet_results.result.core.user_results
              .result.legacy.screen_name === user.result.legacy.screen_name
          ) {
            searchBanFlag = false;
            break;
          }
        }
      }
    }
    const { users: searchSuggestionUsers } = await client
      .get("1.1/search/typeahead.json", {
        searchParams: {
          include_ext_is_blue_verified: "1",
          include_ext_verified_type: "1",
          include_ext_profile_image_shape: "1",
          q: `@${user.result.legacy.screen_name} ${user.result.legacy.name}`,
          src: "search_box",
          result_type: "events,users,topics,lists",
        },
      })
      .json<any>();
    let searchSuggestionBanFlag = true;
    for (const searchSuggestionUser of searchSuggestionUsers) {
      if (searchSuggestionUser.screen_name === user.result.legacy.screen_name) {
        searchSuggestionBanFlag = false;
        break;
      }
    }
    return c.json({
      not_found: false,
      suspend: false,
      protect: false,
      no_tweet: false,
      search_ban: searchBanFlag,
      search_suggestion_ban: searchSuggestionBanFlag,
      no_reply: false,
      ghost_ban: false,
      reply_deboosting: false,
      user: user.result,
    });
  }
);

export type AppType = typeof route;

export const GET = app.fetch;
export const POST = app.fetch;
export const PUT = app.fetch;
export const PATCH = app.fetch;
export const DELETE = app.fetch;
export const HEAD = app.fetch;
export const OPTIONS = app.fetch;
