import { prisma } from '@documenso/prisma';

export interface GetRecipientsForDocumentOptions {
  documentId: number;
  userId: number;
  teamId?: number;
}

export const getRecipientsForDocument = async ({
  documentId,
  userId,
  teamId,
}: GetRecipientsForDocumentOptions) => {
  const recipients = await prisma.recipient.findMany({
    where: {
      documentId,
      document: teamId
        ? {
            team: {
              id: teamId,
              members: {
                some: {
                  userId,
                },
              },
            },
          }
        : {
            userId,
            teamId: null,
          },
    },
    orderBy: [{ signingOrder: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
  });

  return recipients;
};
