import { createElement } from 'react';

import { msg } from '@lingui/core/macro';
import { SendStatus, SigningStatus } from '@prisma/client';

import { mailer } from '@documenso/email/mailer';
import DocumentRejectedEmail from '@documenso/email/templates/document-rejected';
import DocumentRejectionConfirmedEmail from '@documenso/email/templates/document-rejection-confirmed';
import { prisma } from '@documenso/prisma';

import { getI18nInstance } from '../../../client-only/providers/i18n-server';
import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import { FROM_ADDRESS, FROM_NAME } from '../../../constants/email';
import { extractDerivedDocumentEmailSettings } from '../../../types/document-email';
import { renderEmailWithI18N } from '../../../utils/render-email-with-i18n';
import { teamGlobalSettingsToBranding } from '../../../utils/team-global-settings-to-branding';
import { formatDocumentsPath } from '../../../utils/teams';
import type { JobRunIO } from '../../client/_internal/job';
import type { TSendSigningRejectionEmailsJobDefinition } from './send-rejection-emails';

export const run = async ({
  payload,
  io,
}: {
  payload: TSendSigningRejectionEmailsJobDefinition;
  io: JobRunIO;
}) => {
  const { documentId, recipientId } = payload;

  let document;
  let recipient;

  try {
    [document, recipient] = await Promise.all([
      prisma.document.findFirstOrThrow({
        where: {
          id: documentId,
        },
        include: {
          user: true,
          documentMeta: true,
          team: {
            select: {
              teamEmail: true,
              name: true,
              url: true,
              teamGlobalSettings: true,
            },
          },
        },
      }),
      prisma.recipient.findFirstOrThrow({
        where: {
          id: recipientId,
          signingStatus: SigningStatus.REJECTED,
        },
      }),
    ]);
  } catch (err) {
    throw err;
  }

  const { documentMeta, user: documentOwner } = document;

  const isEmailEnabled = extractDerivedDocumentEmailSettings(
    document.documentMeta,
  ).recipientSigningRequest;

  if (!isEmailEnabled) {
    return;
  }

  const i18n = await getI18nInstance(documentMeta?.language);
  const customMailIdentity = documentMeta?.emailSettings?.customMailIdentity;

  // Send confirmation email to the recipient who rejected
  await io.runTask('send-rejection-confirmation-email', async () => {
    const recipientTemplate = createElement(DocumentRejectionConfirmedEmail, {
      recipientName: recipient.name,
      documentName: document.title,
      documentOwnerName: customMailIdentity?.name || customMailIdentity?.email || document.user.name || document.user.email,
      reason: recipient.rejectionReason || '',
      assetBaseUrl: NEXT_PUBLIC_WEBAPP_URL(),
    });

    const branding = document.team?.teamGlobalSettings
      ? teamGlobalSettingsToBranding(document.team.teamGlobalSettings, documentMeta)
      : undefined;

    const [html, text] = await Promise.all([
      renderEmailWithI18N(recipientTemplate, { lang: documentMeta?.language, branding }),
      renderEmailWithI18N(recipientTemplate, {
        lang: documentMeta?.language,
        branding,
        plainText: true,
      }),
    ]);

    await mailer.sendMail({
      to: {
        name: recipient.name,
        address: recipient.email,
      },
      from: {
        name: customMailIdentity?.name || FROM_NAME,
        address: FROM_ADDRESS,
      },
      subject: i18n._(msg`Document "${document.title}" - Rejection Confirmed`),
      html,
      text,
    });
  });

  // Send notification email to document owner
  await io.runTask('send-owner-notification-email', async () => {
    const ownerTemplate = createElement(DocumentRejectedEmail, {
      recipientName: recipient.name,
      documentName: document.title,
      documentUrl: `${NEXT_PUBLIC_WEBAPP_URL()}${formatDocumentsPath(document.team?.url)}/${
        document.id
      }`,
      rejectionReason: recipient.rejectionReason || '',
      assetBaseUrl: NEXT_PUBLIC_WEBAPP_URL(),
    });

    const branding = document.team?.teamGlobalSettings
      ? teamGlobalSettingsToBranding(document.team.teamGlobalSettings)
      : undefined;

    const [html, text] = await Promise.all([
      renderEmailWithI18N(ownerTemplate, { lang: documentMeta?.language, branding }),
      renderEmailWithI18N(ownerTemplate, {
        lang: documentMeta?.language,
        branding,
        plainText: true,
      }),
    ]);

    await mailer.sendMail({
      to: {
        name: customMailIdentity?.name || documentOwner.name || '',
        address: customMailIdentity?.email || documentOwner.email,
      },
      from: {
        name: FROM_NAME,
        address: FROM_ADDRESS,
      },
      subject: i18n._(msg`Document "${document.title}" - Rejected by ${recipient.name}`),
      html,
      text,
    });
  });

  await io.runTask('update-recipient', async () => {
    await prisma.recipient.update({
      where: {
        id: recipient.id,
      },
      data: {
        sendStatus: SendStatus.SENT,
      },
    });
  });
};
